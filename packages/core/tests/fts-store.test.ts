import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { after, describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import type { StoredTextChunk } from "../src/model/text-embed.ts";
import { LibraryPaths } from "../src/library/paths.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";
import type { MetadataStore } from "../src/stores/types.ts";

const roots: string[] = [];
after(async () => {
	await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function asset(assetId: string, relativePath = `${assetId}.md`): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").at(-1) ?? relativePath,
		type: "text",
		size: 10,
		createdAt: 1,
		modifiedAt: 2,
	};
}

/** One parent with one child per text. */
function chunks(assetId: string, ...texts: string[]): StoredTextChunk[] {
	const parentId = `${assetId}-p`;
	return [
		{ chunkId: parentId, assetId, parentId: null, role: "parent", startOffset: 0, endOffset: 1, text: texts.join("\n"), tokenCount: 1 },
		...texts.map((text, index): StoredTextChunk => ({
			chunkId: `${assetId}-c${index}`,
			assetId,
			parentId,
			role: "child",
			startOffset: index,
			endOffset: index + 1,
			text,
			tokenCount: 1,
		})),
	];
}

async function ids(store: MetadataStore, query: string): Promise<string[]> {
	return (await store.searchChunksFts(query, 20)).map((hit) => hit.chunkId).sort();
}

type Make = () => Promise<{ store: MetadataStore; close: () => Promise<void> }>;

const stores: Array<[string, Make]> = [
	["memory", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		return { store, close: async () => undefined };
	}],
	["sqlite", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-fts-"));
		roots.push(root);
		const store = new SqliteMetadataStore();
		await store.open(new LibraryPaths(root));
		return { store, close: () => store.close() };
	}],
];

for (const [name, make] of stores) {
	describe(`chunk full-text (${name})`, () => {
		it("finds Chinese by a word in the middle of a sentence", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.replaceTextChunks("a", chunks("a", "今天天气很好，我们去公园散步", "人工智能的发展改变了世界"));
				assert.deepEqual(await ids(store, "天气"), ["a-c0"]);
				assert.deepEqual(await ids(store, "公园"), ["a-c0"]);
				assert.deepEqual(await ids(store, "智能"), ["a-c1"]);
				assert.deepEqual(await ids(store, "人工智能"), ["a-c1"]);
				assert.deepEqual(await ids(store, "手机"), []);
			} finally {
				await close();
			}
		});

		it("does not match words that are not adjacent", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.replaceTextChunks("a", chunks("a", "天很好气不错"));
				assert.deepEqual(await ids(store, "天气"), []);
			} finally {
				await close();
			}
		});

		it("matches English by prefix and mixes with Chinese", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.replaceTextChunks("a", chunks("a", "Canon EOS R5 camera", "2024年度 report 报告"));
				assert.deepEqual(await ids(store, "cano"), ["a-c0"]);
				assert.deepEqual(await ids(store, "report 报告"), ["a-c1"]);
				assert.deepEqual(await ids(store, "2024年度"), ["a-c1"]);
			} finally {
				await close();
			}
		});

		it("returns the parent text for context and honors the limit", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.replaceTextChunks("a", chunks("a", "apple one", "apple two", "apple three"));
				const [hit] = await store.searchChunksFts("apple", 1);
				assert.ok(hit);
				assert.equal(hit.assetId, "a");
				assert.equal(hit.parentId, "a-p");
				assert.match(hit.parentText ?? "", /apple one/);
				assert.equal((await store.searchChunksFts("apple", 2)).length, 2);
				assert.deepEqual(await store.searchChunksFts("apple", 0), []);
				assert.deepEqual(await store.searchChunksFts("***", 5), []);
			} finally {
				await close();
			}
		});

		it("forgets old text when a file's chunks are replaced", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.replaceTextChunks("a", chunks("a", "alpha only here"));
				assert.deepEqual(await ids(store, "alpha"), ["a-c0"]);
				await store.replaceTextChunks("a", chunks("a", "beta only here"));
				assert.deepEqual(await ids(store, "alpha"), []);
				assert.deepEqual(await ids(store, "beta"), ["a-c0"]);
			} finally {
				await close();
			}
		});

		it("forgets a removed asset, and leaves other assets alone", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.upsertAsset(asset("b"));
				await store.replaceTextChunks("a", chunks("a", "shared word 天气"));
				await store.replaceTextChunks("b", chunks("b", "shared word 天气"));
				assert.deepEqual(await ids(store, "天气"), ["a-c0", "b-c0"]);
				await store.removeAsset("a");
				assert.deepEqual(await ids(store, "shared"), ["b-c0"]);
				assert.deepEqual(await ids(store, "天气"), ["b-c0"]);
			} finally {
				await close();
			}
		});

		it("forgets assets dropped by replaceAssets", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a"));
				await store.upsertAsset(asset("b"));
				await store.replaceTextChunks("a", chunks("a", "gone soon"));
				await store.replaceTextChunks("b", chunks("b", "kept around"));
				await store.replaceAssets([asset("b")]);
				assert.deepEqual(await ids(store, "gone"), []);
				assert.deepEqual(await ids(store, "kept"), ["b-c0"]);
			} finally {
				await close();
			}
		});

		it("forgets a path's old asset when another asset takes the path", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a", "same.md"));
				await store.replaceTextChunks("a", chunks("a", "previous owner"));
				await store.upsertAsset(asset("b", "same.md"));
				assert.deepEqual(await ids(store, "previous"), []);
			} finally {
				await close();
			}
		});
	});

	describe(`file-level full-text with Chinese (${name})`, () => {
		it("finds a word in the middle of a Chinese filename and in a write-up", async () => {
			const { store, close } = await make();
			try {
				await store.upsertAsset(asset("a", "项目/今天天气报告.md"));
				await store.upsertAsset(asset("b", "other.png"));
				await store.upsertImageVlm({
					assetId: "b",
					status: "ready",
					modelId: "m",
					sourceModifiedAt: 2,
					markdown: "## Caption\n人工智能生成的海报",
					updatedAt: 1,
				});
				assert.deepEqual(await store.searchAssetIds("天气"), ["a"]);
				assert.deepEqual(await store.searchAssetIds("智能"), ["b"]);
				assert.deepEqual(await store.searchAssetIds("report"), []);
			} finally {
				await close();
			}
		});
	});
}

describe("sqlite full-text rebuild", () => {
	async function openAt(root: string) {
		const store = new SqliteMetadataStore();
		await store.open(new LibraryPaths(root));
		return store;
	}

	function raw(root: string): Database.Database {
		return new Database(new LibraryPaths(root).metadataDb);
	}

	it("backfills chunk full-text for a library that has chunks but no full-text rows", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-fts-"));
		roots.push(root);
		let store = await openAt(root);
		await store.upsertAsset(asset("a"));
		await store.replaceTextChunks("a", chunks("a", "今天天气很好"));
		await store.close();

		const db = raw(root);
		db.exec("DELETE FROM chunks_fts");
		assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n, 0);
		db.close();

		store = await openAt(root);
		try {
			assert.deepEqual(await ids(store, "天气"), ["a-c0"]);
		} finally {
			await store.close();
		}
	});

	it("rebuilds both tables when they were written under another tokenizing", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-fts-"));
		roots.push(root);
		let store = await openAt(root);
		await store.upsertAsset(asset("a", "天气报告.md"));
		await store.replaceTextChunks("a", chunks("a", "今天天气很好"));
		await store.close();

		// Put back what an older version wrote: unsegmented Chinese, and no format marker.
		const db = raw(root);
		db.exec("DELETE FROM library_meta WHERE key = 'fts_format'");
		db.exec("DELETE FROM chunks_fts; DELETE FROM assets_fts");
		db.prepare("INSERT INTO chunks_fts (rowid, body) SELECT rowid, text FROM text_chunks WHERE role = 'child'").run();
		db.prepare("INSERT INTO assets_fts (asset_id, body) VALUES ('a', '天气报告.md')").run();
		db.close();

		store = await openAt(root);
		try {
			assert.deepEqual(await ids(store, "天气"), ["a-c0"]);
			assert.deepEqual(await store.searchAssetIds("天气"), ["a"]);
		} finally {
			await store.close();
		}
	});

	it("does not rebuild again when the format already matches", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-fts-"));
		roots.push(root);
		let store = await openAt(root);
		await store.upsertAsset(asset("a"));
		await store.replaceTextChunks("a", chunks("a", "marker text"));
		await store.close();

		// Overwrite the stored text with a marker. A rebuild would put "marker text" back.
		const db = raw(root);
		db.prepare("UPDATE chunks_fts SET body = 'sentinel' WHERE rowid = (SELECT rowid FROM text_chunks WHERE role = 'child')").run();
		db.close();

		store = await openAt(root);
		await store.close();
		const check = raw(root);
		try {
			const sentinel = check.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'sentinel'").get() as { n: number };
			assert.equal(sentinel.n, 1);
		} finally {
			check.close();
		}
	});

	it("backfills when the row counts differ even though the format matches", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-fts-"));
		roots.push(root);
		let store = await openAt(root);
		await store.upsertAsset(asset("a"));
		await store.replaceTextChunks("a", chunks("a", "marker text"));
		await store.close();

		const db = raw(root);
		db.exec("DELETE FROM chunks_fts");
		db.close();

		store = await openAt(root);
		try {
			assert.deepEqual(await ids(store, "marker"), ["a-c0"]);
		} finally {
			await store.close();
		}
	});

	it("leaves no full-text row behind when chunks are removed by cascade", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-fts-"));
		roots.push(root);
		const store = await openAt(root);
		await store.upsertAsset(asset("a"));
		await store.replaceTextChunks("a", chunks("a", "one", "two", "three"));
		await store.removeAsset("a");
		await store.close();
		const db = raw(root);
		try {
			assert.equal((db.prepare("SELECT COUNT(*) AS n FROM chunks_fts").get() as { n: number }).n, 0);
			assert.equal((db.prepare("SELECT COUNT(*) AS n FROM text_chunks").get() as { n: number }).n, 0);
		} finally {
			db.close();
		}
	});
});
