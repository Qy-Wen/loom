import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDropLibraryItem } from "../src/renderer/assets/asset-drag.ts";

describe("canDropLibraryItem", () => {
	it("moves a file into another folder", () => {
		assert.equal(canDropLibraryItem("briefs", { kind: "asset", assetId: "a", path: "cover.jpg" }), true);
		assert.equal(canDropLibraryItem("", { kind: "asset", assetId: "a", path: "briefs/cover.jpg" }), true);
	});

	it("does not move a file that is already in the folder", () => {
		assert.equal(canDropLibraryItem("", { kind: "asset", assetId: "a", path: "cover.jpg" }), false);
		assert.equal(canDropLibraryItem("briefs", { kind: "asset", assetId: "a", path: "briefs/cover.jpg" }), false);
	});

	it("rejects dropping a folder into itself", () => {
		assert.equal(canDropLibraryItem("notes", { kind: "folder", relativePath: "notes" }), false);
		assert.equal(canDropLibraryItem("notes/sub", { kind: "folder", relativePath: "notes" }), false);
		assert.equal(canDropLibraryItem("archive", { kind: "folder", relativePath: "notes" }), true);
	});
});
