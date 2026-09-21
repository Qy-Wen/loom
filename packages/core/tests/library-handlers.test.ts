import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	diffLibraryAssets,
	LibraryHandlers,
	type GraphHandlers,
} from "../src/library/handlers.ts";
import type { Asset } from "../src/model/asset.ts";
import { InMemoryMetadataStore } from "../src/stores/memory.ts";

function asset(assetId: string, relativePath: string, fileSystemId = "1:1"): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").at(-1) ?? relativePath,
		type: "image",
		size: 1,
		createdAt: 1,
		modifiedAt: 1,
		fileSystemId,
	};
}

class RecordingGraph implements GraphHandlers {
	readonly events: string[] = [];

	async handleAdded(value: Asset): Promise<void> {
		this.events.push(`added:${value.assetId}`);
	}

	async handleRemoved(value: Asset): Promise<void> {
		this.events.push(`removed:${value.assetId}`);
	}

	async handleMoved(value: Asset, previousPath: string): Promise<void> {
		this.events.push(`moved:${value.assetId}:${previousPath}->${value.relativePath}`);
	}

	async handleUpdated(value: Asset): Promise<void> {
		this.events.push(`updated:${value.assetId}`);
	}
}

describe("diffLibraryAssets", () => {
	it("classifies add, remove, move, and update", () => {
		const situations = diffLibraryAssets(
			[asset("keep", "keep.jpg"), asset("gone", "gone.jpg"), asset("move", "old.jpg"), asset("touch", "touch.jpg")],
			[
				asset("keep", "keep.jpg"),
				asset("move", "new.jpg"),
				{ ...asset("touch", "touch.jpg"), size: 9, modifiedAt: 9 },
				asset("fresh", "fresh.jpg"),
			],
		);
		assert.deepEqual(
			situations.map((situation) => situation.type + ":" + situation.asset.assetId),
			["removed:gone", "moved:move", "updated:touch", "added:fresh"],
		);
	});
});

describe("LibraryHandlers", () => {
	it("writes metadata then notifies the graph for an open reconcile", async () => {
		const metadata = new InMemoryMetadataStore();
		const graph = new RecordingGraph();
		const handlers = new LibraryHandlers(metadata, graph);
		await metadata.open();
		await metadata.upsertAsset(asset("a", "a.jpg", "1:1"));
		await metadata.upsertAsset(asset("b", "b.jpg", "1:2"));

		await handlers.applyOpenReconcile(await metadata.listAssets(), [
			asset("a", "b.jpg", "1:1"),
			asset("b", "a.jpg", "1:2"),
		]);

		assert.equal((await metadata.getAssetByPath("a.jpg"))?.assetId, "b");
		assert.equal((await metadata.getAssetByPath("b.jpg"))?.assetId, "a");
		assert.deepEqual(graph.events, ["moved:a:a.jpg->b.jpg", "moved:b:b.jpg->a.jpg"]);
	});

	it("removes an occupant from metadata and graph when a path is reused", async () => {
		const metadata = new InMemoryMetadataStore();
		const graph = new RecordingGraph();
		const handlers = new LibraryHandlers(metadata, graph);
		await metadata.open();
		await metadata.upsertAsset(asset("old", "hero.jpg", "1:1"));

		await handlers.upsertAsset(asset("new", "hero.jpg", "1:2"));

		assert.equal(await metadata.getAsset("old"), undefined);
		assert.equal((await metadata.getAssetByPath("hero.jpg"))?.assetId, "new");
		assert.deepEqual(graph.events, ["removed:old", "added:new"]);
	});
});
