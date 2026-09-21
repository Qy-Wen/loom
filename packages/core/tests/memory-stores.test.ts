import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Asset } from "../src/asset.ts";
import { InMemoryGraphStore, InMemoryMetadataStore } from "../src/memory-stores.ts";

function asset(assetId: string, relativePath: string): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").at(-1) ?? relativePath,
		type: "image",
		size: 10,
		createdAt: 1,
		modifiedAt: 2,
	};
}

describe("InMemoryMetadataStore", () => {
	it("supports lookup, sorted listing, path changes, and removal", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		await store.upsertAsset(asset("b", "z.jpg"));
		await store.upsertAsset(asset("a", "a.jpg"));

		assert.deepEqual((await store.listAssets()).map((item) => item.assetId), ["a", "b"]);
		assert.equal((await store.getAssetByPath("a.jpg"))?.assetId, "a");

		await store.upsertAsset(asset("a", "nested/a.jpg"));
		assert.equal(await store.getAssetByPath("a.jpg"), undefined);
		assert.equal((await store.getAssetByPath("nested/a.jpg"))?.assetId, "a");

		await store.removeAsset("a");
		assert.equal(await store.getAsset("a"), undefined);
	});

	it("looks up an asset by portable file id", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		await store.upsertAsset({ ...asset("a", "old.jpg"), fileSystemId: "1:99" });
		await store.upsertAsset({ ...asset("a", "new.jpg"), fileSystemId: "1:99" });

		assert.equal((await store.getAssetByFileSystemId("1:99"))?.relativePath, "new.jpg");
		await store.removeAsset("a");
		assert.equal(await store.getAssetByFileSystemId("1:99"), undefined);
	});

	it("replaces the whole asset set in one write", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		await store.upsertAsset({ ...asset("a", "a.jpg"), fileSystemId: "1:1" });
		await store.upsertAsset({ ...asset("b", "b.jpg"), fileSystemId: "1:2" });
		await store.replaceAssets([
			{ ...asset("a", "b.jpg"), fileSystemId: "1:1" },
			{ ...asset("b", "a.jpg"), fileSystemId: "1:2" },
		]);
		assert.equal((await store.getAssetByPath("a.jpg"))?.assetId, "b");
		assert.equal((await store.getAssetByPath("b.jpg"))?.assetId, "a");
		assert.equal((await store.getAssetByFileSystemId("1:1"))?.relativePath, "b.jpg");
	});

	it("stores the library volume id", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		assert.equal(await store.getLibraryVolumeId(), undefined);
		await store.setLibraryVolumeId("1");
		assert.equal(await store.getLibraryVolumeId(), "1");
	});

	it("gives a path to the most recently upserted asset", async () => {
		const store = new InMemoryMetadataStore();
		await store.open();
		await store.upsertAsset(asset("old", "hero.jpg"));
		await store.upsertAsset(asset("new", "hero.jpg"));

		assert.equal(await store.getAsset("old"), undefined);
		assert.equal((await store.getAssetByPath("hero.jpg"))?.assetId, "new");
	});
});

describe("InMemoryGraphStore", () => {
	it("lists relations touching an asset", async () => {
		const store = new InMemoryGraphStore();
		await store.open();
		await store.upsertRelation({ relationId: "r1", fromAssetId: "a", toAssetId: "b", type: "source" });
		await store.upsertRelation({ relationId: "r2", fromAssetId: "c", toAssetId: "a", type: "reference" });
		await store.upsertRelation({ relationId: "r3", fromAssetId: "c", toAssetId: "d", type: "other" });

		assert.deepEqual((await store.listRelations("a")).map((item) => item.relationId), ["r1", "r2"]);
		await store.removeRelation("r1");
		assert.deepEqual((await store.listRelations("a")).map((item) => item.relationId), ["r2"]);
	});
});
