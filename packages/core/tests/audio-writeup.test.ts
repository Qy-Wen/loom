import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import type { AudioWriteupProvider } from "../src/model/audio-writeup.ts";
import { normalizeAudioWriteupMarkdown } from "../src/model/audio-writeup.ts";
import { AudioWriteupService } from "../src/rag/audio-writeup.ts";
import { LocalCore } from "../src/local-core.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";

function audioAsset(assetId = "clip", modifiedAt = 10, size = 24): Asset {
	return {
		assetId,
		relativePath: "clip.mp3",
		filename: "clip.mp3",
		type: "audio",
		size,
		createdAt: 1,
		modifiedAt,
	};
}

function recordingProvider(modelId = "qwen2-audio-7b-instruct"): AudioWriteupProvider & { calls: number } {
	return {
		modelId,
		calls: 0,
		async describe() {
			this.calls += 1;
			return "Rain on a metal roof, no speech.";
		},
	};
}

describe("normalizeAudioWriteupMarkdown", () => {
	it("wraps plain text under Caption", () => {
		assert.match(normalizeAudioWriteupMarkdown("Birds at dawn."), /^## Caption\nBirds at dawn\.\n$/);
	});
});

describe("AudioWriteupService", () => {
	it("persists markdown, skips an unchanged rerun, and remakes on model or mtime change", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = audioAsset();
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const root = await mkdtemp(join(tmpdir(), "loom-audio-writeup-file-"));
		try {
			const path = join(root, "clip.mp3");
			await writeFile(path, Buffer.from("fakeaudio"));
			const service = new AudioWriteupService(store, async () => path, async () => ({
				filename: "clip.mp3",
				bytes: new Uint8Array([1, 2, 3]),
			}));

			const first = await service.describe(asset.assetId, provider);
			assert.equal(first.status, "ready");
			assert.match(first.markdown ?? "", /## Caption/);
			assert.equal(provider.calls, 1);

			const second = await service.describe(asset.assetId, provider);
			assert.equal(second.status, "ready");
			assert.equal(provider.calls, 1);

			const otherModel = recordingProvider("other-audio");
			const third = await service.describe(asset.assetId, otherModel);
			assert.equal(third.status, "ready");
			assert.equal(otherModel.calls, 1);

			await store.upsertAsset({ ...asset, modifiedAt: 20 });
			const fourth = await service.describe(asset.assetId, otherModel);
			assert.equal(fourth.status, "ready");
			assert.equal(otherModel.calls, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("leaves non-audio types idle", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset: Asset = { ...audioAsset(), relativePath: "note.md", filename: "note.md", type: "text" };
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const service = new AudioWriteupService(store, async () => {
			throw new Error("should not read");
		}, async () => {
			throw new Error("should not prepare");
		});
		const status = await service.describe(asset.assetId, provider);
		assert.equal(status.supported, false);
		assert.equal(provider.calls, 0);
	});
});

describe("audio writeup store", () => {
	it("persists write-ups in sqlite", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-audio-writeup-"));
		const store = new SqliteMetadataStore();
		try {
			await store.open(new LibraryPaths(root));
			const asset = audioAsset();
			await store.upsertAsset(asset);
			await store.upsertAudioWriteup({
				assetId: asset.assetId,
				status: "ready",
				modelId: "qwen2-audio-7b-instruct",
				sourceModifiedAt: asset.modifiedAt,
				markdown: "## Caption\nRain on a metal roof.\n",
				updatedAt: 1,
			});
			const row = await store.getAudioWriteup(asset.assetId);
			assert.equal(row?.markdown, "## Caption\nRain on a metal roof.\n");
			assert.equal((await store.searchAssetIds("metal roof")).includes(asset.assetId), true);
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("LocalCore describeAudioAsset", () => {
	it("writes a caption then indexes it through the text embed path", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-audio-core-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "clip.mp3"), "audio-bytes");
			const snapshot = await core.openLibrary(root);
			const asset = snapshot.assets[0];
			assert.ok(asset);
			const status = await core.describeAudioAsset(asset.assetId, recordingProvider());
			assert.equal(status.status, "ready");
			const detail = await core.inspectAsset(asset.assetId);
			assert.equal(detail.audioWriteup.status, "ready");
			assert.equal(detail.textEmbed.supported, true);

			const embed = await core.embedTextAsset(asset.assetId, {
				modelId: "test-embed",
				embed: async (texts) => texts.map(() => [0.1, 0.2]),
			});
			assert.equal(embed.status, "ready");
			assert.equal((await core.searchAssets({ query: "roof" })).total, 1);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
