import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import type { ImageVlmProvider } from "../src/model/image-vlm.ts";
import { canDescribeImage, ImageVlmService } from "../src/rag/image-vlm.ts";
import { prepareImageForModel } from "../src/rag/image-prepare.ts";
import { tryResolveMediaBinaries } from "../src/media/binaries.ts";
import { runMediaProcess } from "../src/media/run.ts";
import { releaseProcessSandbox, setProcessSandboxRoot } from "../src/sandbox/process-sandbox.ts";
import { TextEmbedService } from "../src/rag/service.ts";
import { LocalCore } from "../src/local-core.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";

function imageAsset(assetId = "shot", modifiedAt = 10): Asset {
	return {
		assetId,
		relativePath: "shot.png",
		filename: "shot.png",
		type: "image",
		size: 12,
		createdAt: 1,
		modifiedAt,
	};
}

function recordingProvider(modelId = "test-vlm"): ImageVlmProvider & { calls: number } {
	return {
		modelId,
		calls: 0,
		async describe() {
			this.calls += 1;
			return "A red bicycle on a wet street.";
		},
	};
}

describe("ImageVlmService", () => {
	it("rejects oversized images before resolving the path or calling the provider", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = { ...imageAsset(), size: 10 * 1024 * 1024 + 1 };
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const service = new ImageVlmService(store, async () => { throw new Error("should not read"); }, async () => { throw new Error("should not read"); });
		const status = await service.describe(asset.assetId, provider);
		assert.equal(status.status, "failed");
		assert.match(status.error!, /up to 10 MB/);
		assert.equal(provider.calls, 0);
	});

	it("persists markdown, skips an unchanged rerun, and remakes on model or mtime change", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = imageAsset();
		await store.upsertAsset(asset);
		const bytesProvider: ImageVlmProvider & { calls: number } = {
			modelId: "test-vlm",
			calls: 0,
			async describe(image) {
				this.calls += 1;
				assert.equal(image.filename, "shot.png");
				assert.ok(image.bytes.length > 0);
				return "A red bicycle on a wet street.";
			},
		};

		const root = await mkdtemp(join(tmpdir(), "loom-vlm-file-"));
		try {
			const path = join(root, "shot.png");
			await writeFile(path, Buffer.from("fakepng"));
			const service = new ImageVlmService(store, async () => path, prepareImageForModel);
			const first = await service.describe(asset.assetId, bytesProvider);
			assert.equal(first.status, "ready");
			assert.match(first.markdown ?? "", /## Caption/);
			assert.equal(bytesProvider.calls, 1);

			const second = await service.describe(asset.assetId, bytesProvider);
			assert.equal(second.status, "ready");
			assert.equal(bytesProvider.calls, 1);

			const otherModel: ImageVlmProvider & { calls: number } = {
				modelId: "other-vlm",
				calls: 0,
				async describe() {
					this.calls += 1;
					return "Updated caption.";
				},
			};
			const third = await service.describe(asset.assetId, otherModel);
			assert.equal(third.status, "ready");
			assert.equal(otherModel.calls, 1);
			assert.match(third.markdown ?? "", /Updated caption/);

			await store.upsertAsset({ ...asset, modifiedAt: 20, size: 12 });
			const fourth = await service.describe(asset.assetId, otherModel);
			assert.equal(fourth.status, "ready");
			assert.equal(otherModel.calls, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("leaves unsupported types idle and does not call the provider", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset: Asset = { ...imageAsset(), relativePath: "shot.svg", filename: "shot.svg" };
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const service = new ImageVlmService(store, async () => {
			throw new Error("should not read");
		}, prepareImageForModel);
		const status = await service.describe(asset.assetId, provider);
		assert.equal(status.supported, false);
		assert.equal(provider.calls, 0);
	});
});

describe("image vlm store", () => {
	it("persists write-ups in sqlite", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-image-vlm-"));
		const store = new SqliteMetadataStore();
		try {
			await store.open(new LibraryPaths(root));
			const asset = imageAsset();
			await store.upsertAsset(asset);
			await store.upsertImageVlm({
				assetId: asset.assetId,
				status: "ready",
				modelId: "qwen/qwen3-vl-4b",
				sourceModifiedAt: asset.modifiedAt,
				markdown: "## Caption\nHello.\n",
				updatedAt: 1,
			});
			const row = await store.getImageVlm(asset.assetId);
			assert.equal(row?.markdown, "## Caption\nHello.\n");
			assert.equal(row?.modelId, "qwen/qwen3-vl-4b");
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("LocalCore describeImageAsset", () => {
	it("writes a caption then indexes it through the text embed path", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-vlm-core-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "poster.png"), "png-bytes");
			const snapshot = await core.openLibrary(root);
			const asset = snapshot.assets[0];
			assert.ok(asset);
			const status = await core.describeImageAsset(asset.assetId, recordingProvider());
			assert.equal(status.status, "ready");
			const detail = await core.inspectAsset(asset.assetId);
			assert.equal(detail.imageVlm.status, "ready");
			assert.equal(detail.textEmbed.supported, true);
			assert.equal(detail.textEmbed.status, "idle");

			const embed = await core.embedTextAsset(asset.assetId, {
				modelId: "test-embed",
				embed: async (texts) => texts.map(() => [0.1, 0.2]),
			});
			assert.equal(embed.status, "ready");
			assert.ok(embed.childCount > 0);
			assert.equal((await core.searchAssets({ query: "bicycle" })).total, 1);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("TextEmbedService image write-up", () => {
	it("does not index an image until a VLM write-up exists", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = imageAsset();
		await store.upsertAsset(asset);
		const service = new TextEmbedService(store, async () => undefined);
		const status = await service.getStatus(asset.assetId);
		assert.equal(status.supported, false);
		const embed = await service.embed(asset.assetId, {
			modelId: "test-embed",
			embed: async () => {
				throw new Error("should not embed");
			},
		});
		assert.equal(embed.supported, false);
	});
});

describe("LocalCore describeImageAsset force", () => {
	it("reuses a fresh description unless forced", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-vlm-force-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "poster.png"), "png-bytes");
			const asset = (await core.openLibrary(root)).assets[0]!;
			let calls = 0;
			const provider = { modelId: "m", describe: async () => `## Caption\ncall ${++calls}` };
			await core.describeImageAsset(asset.assetId, provider);
			await core.describeImageAsset(asset.assetId, provider);
			assert.equal(calls, 1);
			const forced = await core.describeImageAsset(asset.assetId, provider, undefined, { force: true });
			assert.equal(calls, 2);
			assert.match(forced.markdown!, /call 2/);
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("prepareImageForModel", () => {
	it("sends non-GIF files unchanged", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-image-prepare-"));
		try {
			const path = join(root, "a.png");
			await writeFile(path, "png-bytes");
			const image = await prepareImageForModel(path);
			assert.equal(image.filename, "a.png");
			assert.equal(Buffer.from(image.bytes).toString(), "png-bytes");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("turns a GIF into the PNG of its first frame", async (t) => {
		if (!tryResolveMediaBinaries()) {
			t.skip("bundled ffmpeg is not installed; run pnpm vendor:ffmpeg");
			return;
		}
		const root = await mkdtemp(join(tmpdir(), "loom-image-gif-"));
		setProcessSandboxRoot(root);
		try {
			const path = join(root, "a.gif");
			const made = await runMediaProcess({
				program: "ffmpeg",
				args: ["-y", "-f", "lavfi", "-i", "testsrc=size=64x48:rate=5:duration=1", path],
			});
			assert.ok(made);
			const image = await prepareImageForModel(path);
			assert.equal(image.filename, "frame.png");
			assert.deepEqual([...image.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
		} finally {
			await releaseProcessSandbox(root);
			await rm(root, { recursive: true, force: true });
		}
	});

	it("describes a GIF as an image", () => {
		assert.equal(canDescribeImage({ ...imageAsset(), relativePath: "a.gif", filename: "a.gif" }), true);
		assert.equal(canDescribeImage({ ...imageAsset(), relativePath: "a.heic", filename: "a.heic" }), false);
	});
});
