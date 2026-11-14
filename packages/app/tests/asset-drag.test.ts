import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDropLibraryItem, draggedAssetIds, readComposerDrag, LOOM_LIBRARY_DRAG, type LibraryDrag } from "../src/renderer/assets/asset-drag.ts";

describe("composer library drops", () => {
	it("keeps mixed folder/file selections without recursively attaching files", () => {
		const item: LibraryDrag = { kind: "batch", assets: [{ assetId: "a", path: "old.md" }], folders: ["notes", "notes", "gone"] };
		const transfer = { getData: (type: string) => type === LOOM_LIBRARY_DRAG ? JSON.stringify(item) : "" } as DataTransfer;
		assert.deepEqual(readComposerDrag(transfer, new Map([["a", { path: "live.md", type: "text" }]]), new Set(["notes"])), [
			{ type: "folder_ref", path: "notes" },
			{ type: "asset_ref", assetId: "a", path: "live.md", assetType: "text" },
		]);
	});
});

describe("canDropLibraryItem", () => {
	it("moves a file into another folder", () => {
		assert.equal(canDropLibraryItem("briefs", { kind: "asset", assetId: "a", path: "cover.jpg" }), true);
		assert.equal(canDropLibraryItem("", { kind: "asset", assetId: "a", path: "briefs/cover.jpg" }), true);
	});

	it("does not move a file that is already in the folder", () => {
		assert.equal(canDropLibraryItem("", { kind: "asset", assetId: "a", path: "cover.jpg" }), false);
		assert.equal(canDropLibraryItem("briefs", { kind: "asset", assetId: "a", path: "briefs/cover.jpg" }), false);
	});

	it("moves a batch except into one of its own folders", () => {
		const batch = {
			kind: "batch" as const,
			assets: [{ assetId: "a", path: "cover.jpg" }],
			folders: ["notes"],
		};
		assert.equal(canDropLibraryItem("archive", batch), true);
		assert.equal(canDropLibraryItem("notes/sub", batch), false);
		assert.equal(canDropLibraryItem("", {
			kind: "batch",
			assets: [{ assetId: "a", path: "cover.jpg" }],
			folders: [],
		}), false);
	});

	it("rejects dropping a folder into itself", () => {
		assert.equal(canDropLibraryItem("notes", { kind: "folder", relativePath: "notes" }), false);
		assert.equal(canDropLibraryItem("notes/sub", { kind: "folder", relativePath: "notes" }), false);
		assert.equal(canDropLibraryItem("archive", { kind: "folder", relativePath: "notes" }), true);
	});
});

describe("draggedAssetIds", () => {
	it("lists the files a drag carries and skips folders", () => {
		assert.deepEqual(draggedAssetIds({ kind: "asset", assetId: "a", path: "a.png" }), ["a"]);
		assert.deepEqual(draggedAssetIds({
			kind: "batch",
			assets: [{ assetId: "a", path: "a.png" }, { assetId: "b", path: "b.png" }],
			folders: ["notes"],
		}), ["a", "b"]);
		assert.deepEqual(draggedAssetIds({ kind: "folder", relativePath: "notes" }), []);
		assert.deepEqual(draggedAssetIds(null), []);
	});
});
