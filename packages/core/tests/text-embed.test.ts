import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import { TEXT_INDEX_LIMIT, type EmbeddingProvider } from "../src/model/text-embed.ts";
import { LocalCore } from "../src/local-core.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { readTextHead, TextEmbedService } from "../src/rag/service.ts";
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

const roots: string[] = [];
after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A store plus a service that reads real files from a temp directory. */
async function workspace(files: Record<string, string> = { "note.md": "# Title\n\nHello world.\n" }) {
	const root = await mkdtemp(join(tmpdir(), "loom-text-embed-"));
	roots.push(root);
	const store = new InMemoryMetadataStore();
	await store.open();
	const write = async (relativePath: string, text: string) => {
		const path = join(root, relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
	};
	for (const [relativePath, text] of Object.entries(files)) await write(relativePath, text);
	const service = new TextEmbedService(store, async (assetId) => {
		const asset = await store.getAsset(assetId);
		return asset ? join(root, asset.relativePath) : undefined;
	});
	return { root, store, service, write };
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
	it("reads a markdown file, embeds children, and skips an unchanged rembed", async () => {
		const { store, service } = await workspace();
		const asset = mdAsset();
		await store.upsertAsset(asset);
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
		const { store, service, write } = await workspace({ "note.md": "hello" });
		const asset = mdAsset();
		await store.upsertAsset(asset);
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
		await write("docs/note.md", "hello again");
		await service.embed(edited.assetId, sameModel);
		assert.equal(sameModel.calls, 1);
		const texts = (await store.listTextChunks(edited.assetId)).map((chunk) => chunk.text);
		assert.ok(texts.some((text) => text.includes("hello again")));
	});

	it("does not embed text formats it cannot convert", async () => {
		const { store, service } = await workspace({ "note.html": "<p>hi</p>" });
		const asset: Asset = { ...mdAsset(), relativePath: "note.html", filename: "note.html" };
		await store.upsertAsset(asset);
		const provider = recordingProvider();
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
					embedding: [0.25, 0.5, 0.75],
					modelId: "m",
				},
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
		const { store, service } = await workspace();
		const asset = mdAsset();
		await store.upsertAsset(asset);
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

describe("TextEmbedService failure", () => {
	async function indexed() {
		const { store, service } = await workspace();
		const asset = mdAsset();
		await store.upsertAsset(asset);
		await service.embed(asset.assetId, recordingProvider("old-model"));
		return { store, asset, service, before: await store.listTextChunks(asset.assetId) };
	}

	it("keeps the previous chunks and vectors when re-embedding fails", async () => {
		const { store, asset, service, before } = await indexed();
		const broken = { modelId: "new-model", embed: async () => { throw new Error("provider down"); } };
		const status = await service.embed(asset.assetId, broken);
		assert.equal(status.status, "failed");
		assert.match(status.error!, /provider down/);
		assert.deepEqual(await store.listTextChunks(asset.assetId), before);
		assert.ok(before.some((chunk) => chunk.role === "child" && chunk.embedding && chunk.modelId === "old-model"));
	});

	it("keeps the previous chunks and vectors when re-embedding is cancelled", async () => {
		const { store, asset, service, before } = await indexed();
		const controller = new AbortController();
		const slow = { modelId: "new-model", embed: async (texts: string[]) => { controller.abort(); return texts.map(() => [1, 1]); } };
		const status = await service.embed(asset.assetId, slow, undefined, controller.signal, { force: true });
		assert.equal(status.status, "failed");
		assert.deepEqual(await store.listTextChunks(asset.assetId), before);
	});
});

describe("TextEmbedService truncated source", () => {
	for (const [label, size, expected] of [
		["is over the index limit", TEXT_INDEX_LIMIT + 1, true],
		["is exactly the index limit", TEXT_INDEX_LIMIT, undefined],
		["is small", 20, undefined],
	] as const) {
		it(`reports truncated=${expected} when the file ${label}`, async () => {
			const { store, service } = await workspace();
			// The flag comes from the recorded size, so the real file can stay small.
			const asset = { ...mdAsset(), size };
			await store.upsertAsset(asset);
			assert.equal((await service.getStatus(asset.assetId)).truncated, undefined);
			const status = await service.embed(asset.assetId, recordingProvider());
			assert.equal(status.status, "ready");
			assert.equal(status.truncated, expected);
		});
	}

	it("never reports truncated for a write-up", async () => {
		const { store, service } = await workspace();
		const asset: Asset = { ...mdAsset(), relativePath: "p.png", filename: "p.png", type: "image", size: TEXT_INDEX_LIMIT * 2 };
		await store.upsertAsset(asset);
		await store.upsertImageVlm({
			assetId: asset.assetId,
			status: "ready",
			sourceModifiedAt: asset.modifiedAt,
			modelId: "vlm",
			markdown: "## Caption\nA red bicycle.",
			updatedAt: 1,
		});
		const status = await service.embed(asset.assetId, recordingProvider());
		assert.equal(status.status, "ready");
		assert.equal(status.truncated, undefined);
	});

	it("fails clearly when the file is gone", async () => {
		const { store, service } = await workspace({});
		const asset = mdAsset();
		await store.upsertAsset(asset);
		const status = await service.embed(asset.assetId, recordingProvider());
		assert.equal(status.status, "failed");
		assert.ok(status.error);
	});
});

describe("TextEmbedService reads the original file", () => {
	it("indexes text past the 256 KiB extract limit", async () => {
		// The extract keeps 256 KiB; the index must not depend on it.
		const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa.\n\n";
		const head = line.repeat(Math.ceil((300 * 1024) / line.length));
		const text = `${head}FINAL-MARKER-PAST-EXTRACT\n`;
		const { store, service } = await workspace({ "note.md": text });
		const asset = { ...mdAsset(), size: Buffer.byteLength(text) };
		await store.upsertAsset(asset);
		const status = await service.embed(asset.assetId, recordingProvider());
		assert.equal(status.status, "ready");
		assert.equal(status.truncated, undefined);
		const chunks = await store.listTextChunks(asset.assetId);
		assert.ok(chunks.some((chunk) => chunk.text.includes("FINAL-MARKER-PAST-EXTRACT")));
	});

	it("indexes only the first MiB of a larger file and says so", async () => {
		const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa.\n\n";
		const body = line.repeat(Math.ceil((TEXT_INDEX_LIMIT + 4096) / line.length));
		const text = `START-MARKER\n\n${body}END-MARKER\n`;
		assert.ok(Buffer.byteLength(text) > TEXT_INDEX_LIMIT);
		const { store, service } = await workspace({ "note.md": text });
		const asset = { ...mdAsset(), size: Buffer.byteLength(text) };
		await store.upsertAsset(asset);
		const status = await service.embed(asset.assetId, recordingProvider());
		assert.equal(status.status, "ready");
		assert.equal(status.truncated, true);
		const chunks = await store.listTextChunks(asset.assetId);
		assert.ok(chunks.some((chunk) => chunk.text.includes("START-MARKER")));
		assert.ok(!chunks.some((chunk) => chunk.text.includes("END-MARKER")));
	});

	it("indexes a file even when no extract exists for it", async () => {
		const { store, service } = await workspace({ "notes.txt": "plain text note\n" });
		const asset: Asset = { ...mdAsset(), relativePath: "notes.txt", filename: "notes.txt" };
		await store.upsertAsset(asset);
		assert.equal(await store.getAssetEnrichment(asset.assetId), undefined);
		const status = await service.embed(asset.assetId, recordingProvider());
		assert.equal(status.status, "ready");
		assert.equal(status.childCount, 1);
	});
});

describe("readTextHead", () => {
	async function file(bytes: Buffer): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "loom-head-"));
		roots.push(root);
		const path = join(root, "a.txt");
		await writeFile(path, bytes);
		return path;
	}

	it("returns a short file whole", async () => {
		const result = await readTextHead(await file(Buffer.from("hello")), 100);
		assert.deepEqual(result, { text: "hello", truncated: false });
	});

	it("does not mark a file exactly at the limit as truncated", async () => {
		const result = await readTextHead(await file(Buffer.from("12345")), 5);
		assert.deepEqual(result, { text: "12345", truncated: false });
	});

	it("cuts a longer file at the limit", async () => {
		const result = await readTextHead(await file(Buffer.from("1234567890")), 5);
		assert.deepEqual(result, { text: "12345", truncated: true });
	});

	it("cuts before a multi-byte character instead of splitting it", async () => {
		// "天气" is 3 bytes per character; a limit of 4 falls inside the second one.
		const result = await readTextHead(await file(Buffer.from("天气很好")), 4);
		assert.deepEqual(result, { text: "天", truncated: true });
		const exact = await readTextHead(await file(Buffer.from("天气很好")), 6);
		assert.deepEqual(exact, { text: "天气", truncated: true });
	});

	it("handles an empty file", async () => {
		assert.deepEqual(await readTextHead(await file(Buffer.alloc(0)), 10), { text: "", truncated: false });
	});
});
