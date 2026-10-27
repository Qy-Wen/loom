import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import type { DescriptionRecord, DescriptionStatus } from "../src/model/description.ts";
import { AudioWriteupService } from "../src/rag/audio-writeup.ts";
import { ImageVlmService } from "../src/rag/image-vlm.ts";
import { prepareImageForModel } from "../src/rag/image-prepare.ts";
import { VideoVlmService } from "../src/rag/video-vlm.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";

interface Provider {
	modelId: string;
	describe(): Promise<string>;
}

interface Service {
	getStatus(assetId: string, modelId?: string): Promise<DescriptionStatus>;
	describe(assetId: string, provider: Provider, onUpdate?: (status: DescriptionStatus) => void, signal?: AbortSignal): Promise<DescriptionStatus>;
}

interface MediaCase {
	type: Asset["type"];
	filename: string;
	create(store: InMemoryMetadataStore, path: string): Service;
	read(store: InMemoryMetadataStore, assetId: string): Promise<DescriptionRecord | undefined>;
	write(store: InMemoryMetadataStore, record: DescriptionRecord): Promise<void>;
}

const mediaCases: MediaCase[] = [
	{
		type: "image", filename: "image.png",
		create: (store, path) => new ImageVlmService(store, async () => path, prepareImageForModel),
		read: (store, id) => store.getImageVlm(id),
		write: (store, record) => store.upsertImageVlm(record),
	},
	{
		type: "video", filename: "video.mp4",
		create: (store, path) => new VideoVlmService(store, async () => path, async () => []),
		read: (store, id) => store.getVideoVlm(id),
		write: (store, record) => store.upsertVideoVlm(record),
	},
	{
		type: "audio", filename: "audio.mp3",
		create: (store, path) => new AudioWriteupService(store, async () => path, async () => ({ filename: "prepared.wav", bytes: new Uint8Array([1]) })),
		read: (store, id) => store.getAudioWriteup(id),
		write: (store, record) => store.upsertAudioWriteup(record),
	},
];

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function setup(t: TestContext, media: MediaCase) {
	const root = await mkdtemp(join(tmpdir(), "loom-description-"));
	const store = new InMemoryMetadataStore();
	await store.open();
	t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
	const path = join(root, media.filename);
	await writeFile(path, "media bytes");
	const asset: Asset = {
		assetId: "asset", filename: media.filename, relativePath: media.filename,
		type: media.type, size: 11, createdAt: 1, modifiedAt: 10,
	};
	await store.upsertAsset(asset);
	return { store, asset, service: media.create(store, path) };
}

for (const media of mediaCases) {
	describe(`${media.type} description workflow`, () => {
		it("publishes persisted transitions and cache hits, and checks model/source freshness", async (t) => {
			const { store, asset, service } = await setup(t, media);
			let calls = 0;
			const provider = { modelId: "m", describe: async () => { calls++; return "caption"; } };
			const updates: DescriptionStatus[] = [];
			const first = await service.describe(asset.assetId, provider, (status) => updates.push(status));
			assert.deepEqual(updates.map((status) => status.status), ["describing", "ready"]);
			assert.equal(first.stale, false);
			assert.equal((await media.read(store, asset.assetId))?.markdown, first.markdown);
			updates.length = 0;
			assert.deepEqual(await service.describe(asset.assetId, provider, (status) => updates.push(status)), first);
			assert.deepEqual(updates.map((status) => status.status), ["ready"]);
			assert.equal(calls, 1);
			assert.equal((await service.getStatus(asset.assetId, "other")).stale, true);
			await service.describe(asset.assetId, { ...provider, modelId: "other" });
			assert.equal(calls, 2);
			await store.upsertAsset({ ...asset, modifiedAt: 20 });
			assert.equal((await service.getStatus(asset.assetId, "other")).stale, true);
			assert.equal((await service.describe(asset.assetId, { ...provider, modelId: "other" })).sourceModifiedAt, 20);
			assert.equal(calls, 3);
		});

		it("regenerates incomplete cached records", async (t) => {
			const { store, asset, service } = await setup(t, media);
			for (const cached of [{ modelId: undefined, markdown: "old" }, { modelId: "m", markdown: "  " }]) {
				await media.write(store, { assetId: asset.assetId, status: "ready", sourceModifiedAt: asset.modifiedAt, updatedAt: 1, ...cached });
				let calls = 0;
				const status = await service.describe(asset.assetId, { modelId: "m", describe: async () => { calls++; return "new"; } });
				assert.equal(calls, 1);
				assert.match(status.markdown!, /new/);
			}
		});

		it("clears old output on failure or empty output and permits retry", async (t) => {
			const { asset, service } = await setup(t, media);
			await service.describe(asset.assetId, { modelId: "old", describe: async () => "old caption" });
			const updates: DescriptionStatus[] = [];
			const failed = await service.describe(asset.assetId, { modelId: "m", describe: async () => { throw new Error("provider offline"); } }, (status) => updates.push(status));
			assert.deepEqual(updates.map((status) => status.status), ["describing", "failed"]);
			assert.match(updates[0]!.markdown!, /old caption/);
			assert.equal(failed.error, "provider offline");
			assert.equal(failed.markdown, undefined);
			const empty = await service.describe(asset.assetId, { modelId: "m", describe: async () => "  " });
			assert.equal(empty.status, "failed");
			assert.match(empty.error!, /empty description/);
			const ready = await service.describe(asset.assetId, { modelId: "m", describe: async () => "retry" });
			assert.equal(ready.status, "ready");
			assert.equal(ready.error, undefined);
		});

		it("cancels an ignored provider, publishes failure, and ignores late output after retry", async (t) => {
			const { store, asset, service } = await setup(t, media);
			const entered = deferred<void>(), late = deferred<string>();
			const controller = new AbortController();
			const updates: DescriptionStatus[] = [];
			const pending = service.describe(asset.assetId, {
				modelId: "m", describe: async () => { entered.resolve(); return late.promise; },
			}, (status) => updates.push(status), controller.signal);
			await entered.promise;
			controller.abort();
			assert.equal((await pending).status, "failed");
			assert.deepEqual(updates.map((status) => status.status), ["describing", "failed"]);
			const ready = await service.describe(asset.assetId, { modelId: "m", describe: async () => "fresh" });
			late.resolve("obsolete");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal((await media.read(store, asset.assetId))?.markdown, ready.markdown);
		});

		it("skips cancelled queued jobs and reads the current asset when the queue resumes", async (t) => {
			const { store, asset, service } = await setup(t, media);
			const entered = deferred<void>(), finish = deferred<string>();
			const active = service.describe(asset.assetId, { modelId: "old", describe: async () => { entered.resolve(); return finish.promise; } });
			await entered.promise;
			const controller = new AbortController();
			let cancelledCalls = 0;
			const updates: DescriptionStatus[] = [];
			const cancelled = service.describe(asset.assetId, {
				modelId: "cancelled", describe: async () => { cancelledCalls++; return "unused"; },
			}, (status) => updates.push(status), controller.signal);
			const rejected = assert.rejects(cancelled, { name: "AbortError" });
			const next = service.describe(asset.assetId, { modelId: "next", describe: async () => "new" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			await store.upsertAsset({ ...asset, modifiedAt: 20 });
			controller.abort();
			finish.resolve("old");
			await active;
			await rejected;
			assert.equal(cancelledCalls, 0);
			assert.equal(updates.length, 0);
			assert.equal((await next).sourceModifiedAt, 20);
		});

		it("rejects a removed queued asset and keeps the queue usable", async (t) => {
			const { store, asset, service } = await setup(t, media);
			const entered = deferred<void>(), finish = deferred<string>();
			const active = service.describe(asset.assetId, { modelId: "m", describe: async () => { entered.resolve(); return finish.promise; } });
			await entered.promise;
			const removed = { ...asset, assetId: "removed", relativePath: `removed-${asset.filename}` };
			await store.upsertAsset(removed);
			let calls = 0;
			const queued = service.describe(removed.assetId, { modelId: "m", describe: async () => { calls++; return "unused"; } });
			const rejected = assert.rejects(queued, /Asset not found/);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await store.removeAsset(removed.assetId);
			finish.resolve("done");
			await active;
			await rejected;
			assert.equal(calls, 0);
			assert.equal(await media.read(store, removed.assetId), undefined);
			assert.equal((await service.describe(asset.assetId, { modelId: "next", describe: async () => "next" })).status, "ready");
		});
	});
}
