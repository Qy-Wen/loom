import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import type { VideoVlmProvider } from "../src/model/video-vlm.ts";
import { extractVideoFramesForVlm, vlmFrameTimes } from "../src/rag/video-frames.ts";
import { VideoVlmService } from "../src/rag/video-vlm.ts";
import { LocalCore } from "../src/local-core.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";
import { tryResolveMediaBinaries } from "../src/media/binaries.ts";
import { releaseProcessSandbox, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";

function videoAsset(assetId = "clip", modifiedAt = 10, size = 24): Asset {
	return {
		assetId,
		relativePath: "clip.mp4",
		filename: "clip.mp4",
		type: "video",
		size,
		createdAt: 1,
		modifiedAt,
	};
}

function recordingProvider(modelId = "test-vlm"): VideoVlmProvider & { calls: number; usedFrames: boolean } {
	return {
		modelId,
		calls: 0,
		usedFrames: false,
		async describe(request) {
			this.calls += 1;
			if (!request.native) this.usedFrames = true;
			return "A person walks out of a car.";
		},
	};
}

describe("vlmFrameTimes", () => {
	it("uses fewer stills for short clips", () => {
		assert.deepEqual(vlmFrameTimes(0), [0]);
		assert.equal(vlmFrameTimes(1).length, 1);
		assert.equal(vlmFrameTimes(4).length, 2);
		assert.deepEqual(vlmFrameTimes(10), [1, 5, 9]);
	});
});

describe("VideoVlmService", () => {
	it("persists markdown, skips an unchanged rerun, and remakes on model or mtime change", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = videoAsset();
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const root = await mkdtemp(join(tmpdir(), "loom-video-vlm-file-"));
		try {
			const path = join(root, "clip.mp4");
			await writeFile(path, Buffer.from("fakevideo"));
			const service = new VideoVlmService(store, async () => path, async () => {
				throw new Error("should not extract");
			});

			const first = await service.describe(asset.assetId, provider);
			assert.equal(first.status, "ready");
			assert.match(first.markdown ?? "", /## Caption/);
			assert.equal(provider.calls, 1);
			assert.equal(provider.usedFrames, false);

			const second = await service.describe(asset.assetId, provider);
			assert.equal(second.status, "ready");
			assert.equal(provider.calls, 1);

			const otherModel = recordingProvider("other-vlm");
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

	it("skips native bytes over the size cap and asks for frames", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = videoAsset("big", 10, 40 * 1024 * 1024);
		await store.upsertAsset(asset);
		let extracted = 0;
		const provider: VideoVlmProvider = {
			modelId: "test-vlm",
			async describe(request) {
				assert.equal(request.native, undefined);
				const first = request.frames();
				assert.equal(request.frames(), first);
				const frames = await first;
				assert.equal(frames.length, 1);
				return "Wide shot of a street.";
			},
		};
		const service = new VideoVlmService(store, async () => "/unused.mp4", async () => {
			extracted += 1;
			return [{ filename: "frame-0.jpg", bytes: new Uint8Array([1, 2, 3]) }];
		});
		const status = await service.describe(asset.assetId, provider);
		assert.equal(status.status, "ready");
		assert.equal(extracted, 1);
	});

	it("leaves non-video types idle", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset: Asset = { ...videoAsset(), relativePath: "note.md", filename: "note.md", type: "text" };
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const service = new VideoVlmService(store, async () => {
			throw new Error("should not read");
		}, async () => {
			throw new Error("should not extract");
		});
		const status = await service.describe(asset.assetId, provider);
		assert.equal(status.supported, false);
		assert.equal(provider.calls, 0);
	});
});

describe("video vlm store", () => {
	it("persists write-ups in sqlite", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-video-vlm-"));
		const store = new SqliteMetadataStore();
		try {
			await store.open(new LibraryPaths(root));
			const asset = videoAsset();
			await store.upsertAsset(asset);
			await store.upsertVideoVlm({
				assetId: asset.assetId,
				status: "ready",
				modelId: "qwen/qwen3-vl-4b",
				sourceModifiedAt: asset.modifiedAt,
				markdown: "## Caption\nA person disembarks.\n",
				updatedAt: 1,
			});
			const row = await store.getVideoVlm(asset.assetId);
			assert.equal(row?.markdown, "## Caption\nA person disembarks.\n");
			assert.equal((await store.searchAssetIds("disembarks")).includes(asset.assetId), true);
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("LocalCore describeVideoAsset", () => {
	it("writes a caption then indexes it through the text embed path", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-video-core-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "clip.mp4"), "video-bytes");
			const snapshot = await core.openLibrary(root);
			const asset = snapshot.assets[0];
			assert.ok(asset);
			const status = await core.describeVideoAsset(asset.assetId, recordingProvider());
			assert.equal(status.status, "ready");
			const detail = await core.inspectAsset(asset.assetId);
			assert.equal(detail.videoVlm.status, "ready");
			assert.equal(detail.textEmbed.supported, true);

			const embed = await core.embedTextAsset(asset.assetId, {
				modelId: "test-embed",
				embed: async (texts) => texts.map(() => [0.1, 0.2]),
			});
			assert.equal(embed.status, "ready");
			assert.equal((await core.searchAssets({ query: "walks" })).total, 1);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("extractVideoFramesForVlm", () => {
	it("writes jpeg stills from a real clip", async (t) => {
		if (!tryResolveMediaBinaries()) {
			t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
			return;
		}
		const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "media");
		const root = await mkdtemp(join(tmpdir(), "loom-vlm-frames-"));
		setProcessSandboxRoot(root);
		try {
			const path = join(root, "clip.mp4");
			await copyFile(join(fixtures, "clip.mp4"), path);
			const frames = await extractVideoFramesForVlm(path);
			assert.ok(frames.length >= 1);
			assert.equal(frames[0]?.bytes[0], 0xff);
			assert.equal(frames[0]?.bytes[1], 0xd8);
		} finally {
			await releaseProcessSandbox(root);
			await rm(root, { recursive: true, force: true });
		}
	});
});
