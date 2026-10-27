import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { EnrichmentService } from "../src/enrichment/service.ts";
import { ENRICHMENT_VERSION } from "../src/model/enrichment.ts";
import type { Asset } from "../src/model/asset.ts";
import type { EmbeddingProvider } from "../src/model/text-embed.ts";
import { LocalCore } from "../src/local-core.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { TextEmbedService } from "../src/rag/service.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";

function mdAsset(assetId = "note", modifiedAt = 10): Asset {
	return {
		assetId,
		relativePath: "note.md",
		filename: "note.md",
		type: "text",
		size: 20,
		createdAt: 1,
		modifiedAt,
	};
}

function recordingProvider(modelId = "test-embed"): EmbeddingProvider & { calls: number; texts: string[][] } {
	const texts: string[][] = [];
	return {
		modelId,
		calls: 0,
		texts,
		async embed(batch: string[]) {
			this.calls += 1;
			texts.push(batch);
			return batch.map((_, index) => [index + 1, 0.5]);
		},
	};
}

describe("TextEmbedService", () => {
	it("chunks a markdown extract, embeds children, and skips an unchanged rembed", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = mdAsset();
		await store.upsertAsset(asset);
		await store.upsertAssetEnrichment({
			assetId: asset.assetId,
			version: ENRICHMENT_VERSION,
			sourceModifiedAt: asset.modifiedAt,
			status: "ready",
			data: { kind: "text", text: "# Title\n\nHello world.\n", truncated: false, charCount: 22 },
		});
		const enrichment = new EnrichmentService(store, async () => undefined);
		const service = new TextEmbedService(store, enrichment);
		const provider = recordingProvider();

		const first = await service.embed(asset.assetId, provider);
		assert.equal(first.status, "ready");
		assert.equal(first.childCount, 1);
		assert.equal(first.parentCount, 1);
		assert.equal(provider.calls, 1);

		const chunks = await store.listTextChunks(asset.assetId);
		const child = chunks.find((chunk) => chunk.role === "child");
		const parent = chunks.find((chunk) => chunk.role === "parent");
		assert.ok(child && parent);
		assert.equal(parent.parentId, null);
		assert.equal(child.parentId, parent.chunkId);
		assert.deepEqual(child.embedding, [1, 0.5]);
		assert.equal(child.modelId, "test-embed");
		assert.equal(parent.embedding, undefined);

		const second = await service.embed(asset.assetId, provider);
		assert.equal(second.status, "ready");
		assert.equal(provider.calls, 1);
	});

	it("re-embeds when the model or source mtime changes", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = mdAsset();
		await store.upsertAsset(asset);
		await store.upsertAssetEnrichment({
			assetId: asset.assetId,
			version: ENRICHMENT_VERSION,
			sourceModifiedAt: asset.modifiedAt,
			status: "ready",
			data: { kind: "text", text: "hello", truncated: false, charCount: 5 },
		});
		const service = new TextEmbedService(store, new EnrichmentService(store, async () => undefined));
		const first = recordingProvider("alpha");
		await service.embed(asset.assetId, first);
		const otherModel = recordingProvider("beta");
		await service.embed(asset.assetId, otherModel);
		assert.equal(otherModel.calls, 1);

		const moved = { ...asset, relativePath: "docs/note.md", filename: "note.md" };
		await store.upsertAsset(moved);
		const sameModel = recordingProvider("beta");
		await service.embed(moved.assetId, sameModel);
		assert.equal(sameModel.calls, 0);

		const edited = { ...moved, modifiedAt: 99 };
		await store.upsertAsset(edited);
		await store.upsertAssetEnrichment({
			assetId: edited.assetId,
			version: ENRICHMENT_VERSION,
			sourceModifiedAt: edited.modifiedAt,
			status: "ready",
			data: { kind: "text", text: "hello again", truncated: false, charCount: 11 },
		});
		await service.embed(edited.assetId, sameModel);
		assert.equal(sameModel.calls, 1);
	});

	it("does not embed text formats it cannot convert", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset: Asset = { ...mdAsset(), relativePath: "note.html", filename: "note.html" };
		await store.upsertAsset(asset);
		const provider = recordingProvider();
		const service = new TextEmbedService(store, new EnrichmentService(store, async () => undefined));
		const status = await service.embed(asset.assetId, provider);
		assert.equal(status.supported, false);
		assert.equal(status.status, "idle");
		assert.equal(provider.calls, 0);
	});
});

describe("text chunk store", () => {
	it("persists child vectors in sqlite", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-text-embed-"));
		const store = new SqliteMetadataStore();
		try {
			await store.open(new LibraryPaths(root));
			const asset = mdAsset();
			await store.upsertAsset(asset);
			await store.replaceTextChunks(asset.assetId, [
				{
					chunkId: "p1",
					assetId: asset.assetId,
					parentId: null,
					role: "parent",
					startOffset: 0,
					endOffset: 5,
					text: "hello",
					tokenCount: 1,
				},
				{
					chunkId: "c1",
					assetId: asset.assetId,
					parentId: "p1",
					role: "child",
					startOffset: 0,
					endOffset: 5,
					text: "hello",
					tokenCount: 1,
				},
			]);
			await store.updateChildEmbeddings(asset.assetId, [
				{ chunkId: "c1", embedding: [0.25, 0.5, 0.75], modelId: "m" },
			]);
			const chunks = await store.listTextChunks(asset.assetId);
			const child = chunks.find((chunk) => chunk.chunkId === "c1");
			assert.ok(child?.embedding);
			assert.equal(child.embedding.length, 3);
			assert.ok(Math.abs(child.embedding[0]! - 0.25) < 1e-6);
			assert.equal(child.modelId, "m");
		} finally {
			await store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("LocalCore embedTextAsset", () => {
	it("extracts a markdown file then indexes children", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-embed-core-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "guide.md"), "# Guide\n\nSome notes.\n");
			const snapshot = await core.openLibrary(root);
			const asset = snapshot.assets[0];
			assert.ok(asset);
			const provider = recordingProvider();
			const status = await core.embedTextAsset(asset.assetId, provider);
			assert.equal(status.status, "ready");
			assert.equal(status.childCount, 1);
			assert.equal(provider.calls, 1);
			const detail = await core.inspectAsset(asset.assetId);
			assert.equal(detail.textEmbed.status, "ready");
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("TextEmbedService force", () => {
	it("skips a current index unless forced, then rebuilds every vector", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = mdAsset();
		await store.upsertAsset(asset);
		await store.upsertAssetEnrichment({
			assetId: asset.assetId,
			version: ENRICHMENT_VERSION,
			sourceModifiedAt: asset.modifiedAt,
			status: "ready",
			data: { kind: "text", text: "# Title\n\nHello world.\n", truncated: false, charCount: 22 },
		});
		const service = new TextEmbedService(store, new EnrichmentService(store, async () => undefined));
		const provider = recordingProvider();
		await service.embed(asset.assetId, provider);
		await service.embed(asset.assetId, provider);
		assert.equal(provider.calls, 1);
		const forced = await service.embed(asset.assetId, provider, undefined, undefined, { force: true });
		assert.equal(provider.calls, 2);
		assert.equal(forced.status, "ready");
		const chunks = await store.listTextChunks(asset.assetId);
		assert.equal(chunks.filter((chunk) => chunk.role === "child").length, forced.childCount);
	});
});
