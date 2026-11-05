import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalCore } from "../src/local-core.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { LibraryTaskScope, abortableProviderCall } from "../src/library/task-scope.ts";
import { InMemoryGraphStore, InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";
import { VideoVlmService } from "../src/rag/video-vlm.ts";
import type { Asset, LibraryChange } from "../src/model/asset.ts";
import type { AssetEnrichment } from "../src/model/enrichment.ts";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function workspace(t: TestContext, metadata = new SqliteMetadataStore()) {
	const root = await mkdtemp(join(tmpdir(), "loom-job-life-"));
	const a = join(root, "a"), b = join(root, "b");
	await mkdir(a); await mkdir(b);
	await writeFile(join(a, "shot.png"), "image bytes");
	await writeFile(join(a, "note.md"), "# A note");
	await writeFile(join(b, "shot.png"), "other image bytes");
	const core = new LocalCore({ metadataStore: metadata, graphStore: new InMemoryGraphStore() });
	t.after(async () => { await core.close(); await rm(root, { recursive: true, force: true }); });
	const first = await core.openLibrary(a);
	return { a, b, core, metadata, image: first.assets.find((asset) => asset.type === "image")!, note: first.assets.find((asset) => asset.type === "text")! };
}

test("switching cancels active and queued descriptions; late provider output cannot reach B or reopened A", { timeout: 10000 }, async (t) => {
	const { a, b, core, metadata, image } = await workspace(t);
	const entered = deferred<AbortSignal>(), late = deferred<string>();
	let calls = 0;
	const provider = {
		modelId: "suspended",
		describe: async (_input: unknown, signal?: AbortSignal) => {
			calls++; entered.resolve(signal!);
			return late.promise; // Deliberately ignore abort.
		},
	};
	const active = core.describeImageAsset(image.assetId, provider);
	const activeRejected = assert.rejects(active, { name: "AbortError" });
	const signal = await entered.promise;
	const queued = core.describeImageAsset(image.assetId, provider);
	const queuedRejected = assert.rejects(queued);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await core.openLibrary(b);
	await Promise.all([activeRejected, queuedRejected]);
	assert.equal(signal.aborted, true);
	assert.equal(calls, 1);
	const events: LibraryChange[] = [];
	const off = core.subscribeLibrary((change) => events.push(change));
	// Even a copied asset identity in the new library must not receive old output.
	const other = (await core.getLibrarySnapshot()).assets[0]!;
	await metadata.upsertAsset({ ...other, assetId: image.assetId });
	late.resolve(JSON.stringify({ caption: "late old caption", tags: [], transcript: null }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(await metadata.getImageVlm(image.assetId), undefined);
	assert.equal(events.some((change) => change.type === "image_vlm"), false);
	off();
	await core.openLibrary(a);
	const status = await core.getImageVlmStatus(image.assetId);
	assert.equal(status.status, "failed");
	assert.equal(status.description?.caption, undefined);
	const retried = await core.describeImageAsset(image.assetId, { modelId: "retry", describe: async () => JSON.stringify({ caption: "new caption", tags: [], transcript: null }) });
	assert.equal(retried.status, "ready");
	assert.match(retried.description?.caption!, /new caption/);
});

test("close drains embedding cancellation before closing SQLite and reopening permits retry", { timeout: 10000 }, async (t) => {
	const { a, core, note } = await workspace(t);
	const entered = deferred<AbortSignal>(), late = deferred<number[][]>();
	const job = core.embedTextAsset(note.assetId, {
		modelId: "pending",
		embed: async (_texts, signal) => { entered.resolve(signal!); return late.promise; },
	});
	const rejected = assert.rejects(job, { name: "AbortError" });
	const signal = await entered.promise;
	await core.close();
	await rejected;
	assert.equal(signal.aborted, true);
	await core.openLibrary(a);
	assert.equal((await core.getTextEmbedStatus(note.assetId)).status, "failed");
	late.resolve([[9, 9]]);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const ready = await core.embedTextAsset(note.assetId, { modelId: "retry", embed: async (texts) => texts.map(() => [1, 0]) });
	assert.equal(ready.status, "ready");
});

test("a preparatory await stays bound to its original opening and cannot submit after the switch", async (t) => {
	const { b, core, image } = await workspace(t);
	const entered = deferred<void>(), settings = deferred<void>();
	let providerCalled = false;
	const pending = core.runLibraryTask(async (signal) => {
		entered.resolve();
		await settings.promise;
		signal.throwIfAborted();
		return core.describeImageAsset(image.assetId, {
			modelId: "old",
			describe: async () => { providerCalled = true; return JSON.stringify({ caption: "wrong", tags: [], transcript: null }); },
		}, signal);
	});
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await entered.promise;
	const switched = core.openLibrary(b);
	await assert.rejects(core.describeImageAsset(image.assetId, { modelId: "new", describe: async () => JSON.stringify({ caption: "", tags: [], transcript: null }) }), /not accepting/);
	settings.resolve();
	await Promise.all([switched, rejected]);
	assert.equal(providerCalled, false);
});

test("in-progress enrichment commits finish before old storage closes", { timeout: 10000 }, async (t) => {
	const entered = deferred<void>(), release = deferred<void>();
	class BlockingMetadata extends SqliteMetadataStore {
		block = true;
		override async upsertAssetEnrichment(record: AssetEnrichment): Promise<void> {
			if (this.block) { this.block = false; entered.resolve(); await release.promise; }
			return super.upsertAssetEnrichment(record);
		}
	}
	const metadata = new BlockingMetadata();
	const { core, b } = await workspace(t, metadata);
	await entered.promise;
	let opened = false;
	const switching = core.openLibrary(b).then(() => { opened = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(opened, false);
	release.resolve();
	await switching;
	assert.equal((await core.getLibrarySnapshot()).rootPath, b);
});

test("overlapping opens and close serialize their storage lifetimes", async (t) => {
	const { core, a, b } = await workspace(t);
	const first = core.openLibrary(b), second = core.openLibrary(a), closed = core.close();
	await Promise.all([first, second, closed]);
	assert.equal((await core.getLibrarySnapshot()).rootPath, null);
	await core.openLibrary(b);
	assert.equal((await core.getLibrarySnapshot()).rootPath, b);
});

test("a failed open closes resources and admits a later valid opening", async (t) => {
	const { core, a } = await workspace(t);
	await assert.rejects(core.openLibrary(join(a, "missing")));
	assert.equal((await core.getLibrarySnapshot()).rootPath, null);
	await core.openLibrary(a);
	assert.equal((await core.getLibrarySnapshot()).rootPath, a);
});

for (const storage of ["sqlite", "memory"] as const) {
	test(storage + " recovery changes only interrupted records and preserves completed output", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "loom-job-recovery-"));
		const store = storage === "sqlite" ? new SqliteMetadataStore() : new InMemoryMetadataStore();
		t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
		await store.open(new LibraryPaths(root));
		const asset: Asset = { assetId: "one", filename: "shot.png", relativePath: "shot.png", type: "image", size: 10, createdAt: 1, modifiedAt: 1 };
		await store.upsertAsset(asset);
		const record = { assetId: asset.assetId, sourceModifiedAt: 1, updatedAt: 1, modelId: "m", description: { caption: "old output", tags: [] } };
		await store.upsertImageVlm({ ...record, status: "describing" });
		await store.upsertVideoVlm({ ...record, status: "describing" });
		await store.upsertAudioWriteup({ ...record, status: "ready" });
		await store.upsertTextEmbedJob({ ...record, status: "embedding", childCount: 1, parentCount: 1 });
		await store.recoverInterruptedJobs();
		for (const row of [await store.getImageVlm("one"), await store.getVideoVlm("one"), await store.getTextEmbedJob("one")]) {
			assert.equal(row?.status, "failed");
			assert.match(row?.error ?? "", /interrupted/);
		}
		assert.equal((await store.getAudioWriteup("one"))?.status, "ready");
		assert.equal((await store.getAudioWriteup("one"))?.description?.caption, "old output");
	});
}

test("opening SQLite recovers records left describing by a terminated session", async (t) => {
	const { a, core, image, metadata } = await workspace(t);
	await metadata.upsertImageVlm({ assetId: image.assetId, status: "describing", sourceModifiedAt: image.modifiedAt, updatedAt: 1 });
	await core.close();
	await core.openLibrary(a);
	assert.equal((await core.getImageVlmStatus(image.assetId)).status, "failed");
});

test("video cancellation waits for lazy frame extraction cleanup", async () => {
	const store = new InMemoryMetadataStore(); await store.open();
	const asset: Asset = { assetId: "video", filename: "clip.mp4", relativePath: "clip.mp4", type: "video", size: 40 * 1024 * 1024, createdAt: 1, modifiedAt: 1 };
	await store.upsertAsset(asset);
	const entered = deferred<void>(), cleanup = deferred<void>();
	const scope = new LibraryTaskScope();
	const service = new VideoVlmService(store, async () => "/unused", async (_path, signal) => {
		entered.resolve();
		await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
		await cleanup.promise;
		throw signal!.reason;
	});
	const job = scope.run((signal) => service.describe("video", { modelId: "m", describe: async (input) => { await input.frames(); return JSON.stringify({ caption: "unused", tags: [], transcript: null }); } }, undefined, signal));
	const rejected = assert.rejects(job, { name: "AbortError" });
	await entered.promise; scope.cancel();
	let drained = false;
	const drain = scope.drain().then(() => { drained = true; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(drained, false);
	cleanup.resolve();
	await Promise.all([drain, rejected]);
	assert.equal((await store.getVideoVlm("video"))?.status, "failed");
});

test("scope cancellation before admission never calls an external provider", async () => {
	const scope = new LibraryTaskScope();
	const job = scope.run((signal) => abortableProviderCall(async () => { throw new Error("must not start"); }, signal));
	scope.cancel();
	await assert.rejects(job, { name: "AbortError" });
	await scope.drain();
});

test("caller cancellation still publishes failed status in the active library and a retry survives late output", async (t) => {
	const { core, image } = await workspace(t);
	const controller = new AbortController(), entered = deferred<void>(), late = deferred<string>();
	const events: LibraryChange[] = [];
	const off = core.subscribeLibrary((change) => events.push(change));
	const pending = core.describeImageAsset(image.assetId, {
		modelId: "old",
		describe: async () => { entered.resolve(); return late.promise; },
	}, controller.signal);
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await entered.promise; controller.abort();
	await rejected;
	assert.equal((await core.getImageVlmStatus(image.assetId)).status, "failed");
	assert.equal(events.filter((event) => event.type === "image_vlm").length, 2);
	const next = await core.describeImageAsset(image.assetId, { modelId: "next", describe: async () => JSON.stringify({ caption: "fresh", tags: [], transcript: null }) });
	late.resolve(JSON.stringify({ caption: "obsolete", tags: [], transcript: null }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal((await core.getImageVlmStatus(image.assetId)).description?.caption, next.description?.caption);
	off();
});
