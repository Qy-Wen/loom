import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EnrichmentService } from "../src/enrichment/service.ts";
import { extractEnrichment } from "../src/enrichment/extract.ts";
import { ENRICHMENT_VERSION, TEXT_ENRICHMENT_LIMIT } from "../src/model/enrichment.ts";
import { LocalCore } from "../src/local-core.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";
import type { Asset } from "../src/model/asset.ts";

const PNG_1X1 = Buffer.from(
	"89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc000000301010018dd8dbf0000000049454e44ae426082",
	"hex",
);

function textAsset(assetId: string, modifiedAt = 10): Asset {
	return {
		assetId,
		relativePath: "note.txt",
		filename: "note.txt",
		type: "text",
		size: 4,
		createdAt: 1,
		modifiedAt,
	};
}

describe("extractEnrichment", () => {
	it("reads png dimensions and extracts limited text", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-enrich-extract-"));
		try {
			const png = join(root, "dot.png");
			const note = join(root, "note.txt");
			const longNote = join(root, "long.txt");
			await writeFile(png, PNG_1X1);
			await writeFile(note, "hello world");
			await writeFile(longNote, Buffer.alloc(TEXT_ENRICHMENT_LIMIT + 8, 97));
			assert.deepEqual(await extractEnrichment(png, "image", "dot.png"), {
				kind: "image",
				width: 1,
				height: 1,
			});
			assert.deepEqual(await extractEnrichment(note, "text", "note.txt"), {
				kind: "text",
				text: "hello world",
				truncated: false,
				charCount: 11,
			});
			const truncated = await extractEnrichment(longNote, "text", "long.txt");
			assert.equal(truncated.kind, "text");
			if (truncated.kind === "text") {
				assert.equal(truncated.truncated, true);
				assert.equal(truncated.charCount, TEXT_ENRICHMENT_LIMIT);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("EnrichmentService", () => {
	it("skips unchanged files and re-extracts after the source mtime changes", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = textAsset("a");
		await store.upsertAsset(asset);
		let calls = 0;
		const service = new EnrichmentService(store, async () => "/tmp/note.txt", async () => {
			calls += 1;
			return { kind: "text", text: `run-${calls}`, truncated: false, charCount: 5 };
		});

		await service.refreshStale([asset]);
		await service.refreshStale([asset]);
		assert.equal(calls, 1);
		assert.deepEqual((await store.getAssetEnrichment("a"))?.data, {
			kind: "text",
			text: "run-1",
			truncated: false,
			charCount: 5,
		});

		const updated = { ...asset, modifiedAt: 99 };
		await store.upsertAsset(updated);
		await service.refreshStale([updated]);
		assert.equal(calls, 2);
		assert.equal((await service.analyze("a")).status, "ready");
		assert.equal(calls, 3);
	});

	it("stores failed extractor errors with library-relative asset paths", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		const asset = { ...textAsset("bad"), relativePath: "nested/note.txt" };
		await store.upsertAsset(asset);
		const absolutePath = "/private/library/nested/note.txt";
		const service = new EnrichmentService(store, async () => absolutePath, async () => {
			throw new Error(`Cannot read ${absolutePath}: invalid input`);
		});

		const record = await service.analyze(asset.assetId);
		assert.equal(record.status, "failed");
		assert.equal(record.error, "Cannot read nested/note.txt: invalid input");
		assert.equal((await store.getAssetEnrichment(asset.assetId))?.error, record.error);
	});
});

describe("LocalCore enrichment", () => {
	it("persists image metadata and does not re-enrich a rename", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-enrich-core-"));
		const core = new LocalCore();
		try {
			await writeFile(join(root, "dot.png"), PNG_1X1);
			const snapshot = await core.openLibrary(root);
			const asset = snapshot.assets[0];
			assert.ok(asset);
			const first = await core.analyzeAsset(asset.assetId);
			assert.equal(first.status, "ready");
			assert.deepEqual(first.data, { kind: "image", width: 1, height: 1 });
			assert.equal(first.version, ENRICHMENT_VERSION);

			const renamed = await core.renameAsset(asset.assetId, "pixel");
			const afterRename = await core.refreshEnrichment((await core.getLibrarySnapshot()).assets);
			if (renamed.modifiedAt === asset.modifiedAt) {
				assert.equal(afterRename.length, 0);
			}
			const stored = await core.getAssetEnrichment(asset.assetId);
			assert.deepEqual(stored?.data, first.data);
			if (renamed.modifiedAt === asset.modifiedAt) {
				assert.equal(stored?.sourceModifiedAt, first.sourceModifiedAt);
			}

			await core.close();
			const reopened = new LocalCore();
			try {
				await reopened.openLibrary(root);
				const persisted = await reopened.getAssetEnrichment(asset.assetId);
				assert.deepEqual(persisted?.data, first.data);
			} finally {
				await reopened.close();
			}
		} finally {
			await core.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
