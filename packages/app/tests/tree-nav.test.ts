import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isLibraryTrashKey,
	treeMotion,
	visibleTreeRows,
	type TreeAssetRef,
	type TreeRow,
} from "../src/renderer/library/tree-nav.ts";

const assets: TreeAssetRef[] = [
	{ assetId: "z", relativePath: "a/z.txt" },
	{ assetId: "m", relativePath: "m.txt" },
	{ assetId: "n", relativePath: "a/c/n.txt" },
];

function paths(rows: TreeRow[]): string[] {
	return rows.map((row) => row.relativePath);
}

describe("visibleTreeRows", () => {
	it("lists folders before files and hides children of a collapsed folder", () => {
		assert.deepEqual(paths(visibleTreeRows(["b", "a", "a/c"], assets, new Set())), [
			"a",
			"a/c",
			"a/c/n.txt",
			"a/z.txt",
			"b",
			"m.txt",
		]);
		assert.deepEqual(paths(visibleTreeRows(["b", "a", "a/c"], assets, new Set(["a"]))), [
			"a",
			"b",
			"m.txt",
		]);
	});
});

describe("treeMotion", () => {
	const rows = visibleTreeRows(["b", "a", "a/c"], assets, new Set(["a/c"]));

	it("walks visible rows with the arrow keys and home and end", () => {
		assert.deepEqual(treeMotion(rows, null, "ArrowDown"), {
			type: "select",
			cursor: { kind: "folder", relativePath: "a" },
		});
		assert.deepEqual(treeMotion(rows, { kind: "folder", relativePath: "a" }, "ArrowDown"), {
			type: "select",
			cursor: { kind: "folder", relativePath: "a/c" },
		});
		assert.deepEqual(treeMotion(rows, { kind: "asset", assetId: "m", relativePath: "m.txt" }, "ArrowUp"), {
			type: "select",
			cursor: { kind: "folder", relativePath: "b" },
		});
		assert.equal(treeMotion(rows, { kind: "folder", relativePath: "a" }, "ArrowUp").type, "none");
		assert.equal(treeMotion(rows, { kind: "asset", assetId: "m", relativePath: "m.txt" }, "ArrowDown").type, "none");
		assert.deepEqual(treeMotion(rows, { kind: "folder", relativePath: "b" }, "Home"), {
			type: "select",
			cursor: { kind: "folder", relativePath: "a" },
		});
		assert.deepEqual(treeMotion(rows, null, "End"), {
			type: "select",
			cursor: { kind: "asset", assetId: "m", relativePath: "m.txt" },
		});
	});

	it("collapses an open folder, then moves to its parent", () => {
		assert.deepEqual(treeMotion(rows, { kind: "folder", relativePath: "a" }, "ArrowLeft"), {
			type: "collapse",
			relativePath: "a",
		});
		const collapsed = visibleTreeRows(["b", "a", "a/c"], assets, new Set(["a", "a/c"]));
		assert.deepEqual(treeMotion(collapsed, { kind: "folder", relativePath: "a" }, "ArrowLeft").type, "none");
		assert.deepEqual(treeMotion(rows, { kind: "asset", assetId: "z", relativePath: "a/z.txt" }, "ArrowLeft"), {
			type: "select",
			cursor: { kind: "folder", relativePath: "a" },
		});
	});

	it("expands a closed folder, then enters its first child", () => {
		assert.deepEqual(treeMotion(rows, { kind: "folder", relativePath: "a/c" }, "ArrowRight"), {
			type: "expand",
			relativePath: "a/c",
		});
		const open = visibleTreeRows(["b", "a", "a/c"], assets, new Set());
		assert.deepEqual(treeMotion(open, { kind: "folder", relativePath: "a/c" }, "ArrowRight"), {
			type: "select",
			cursor: { kind: "asset", assetId: "n", relativePath: "a/c/n.txt" },
		});
		assert.equal(treeMotion(open, { kind: "asset", assetId: "n", relativePath: "a/c/n.txt" }, "ArrowRight").type, "none");
	});

	it("toggles the focused folder on enter", () => {
		assert.deepEqual(treeMotion(rows, { kind: "folder", relativePath: "a/c" }, "Enter"), {
			type: "expand",
			relativePath: "a/c",
		});
		assert.deepEqual(treeMotion(rows, { kind: "folder", relativePath: "a" }, "Enter"), {
			type: "collapse",
			relativePath: "a",
		});
		assert.equal(treeMotion(rows, { kind: "asset", assetId: "m", relativePath: "m.txt" }, "Enter").type, "none");
	});

	it("moves through a locked-open search listing without folding", () => {
		const open = visibleTreeRows(["b", "a", "a/c"], assets, new Set());
		assert.deepEqual(treeMotion(open, { kind: "folder", relativePath: "a" }, "ArrowLeft", false).type, "none");
		assert.deepEqual(treeMotion(open, { kind: "folder", relativePath: "a" }, "ArrowRight", false), {
			type: "select",
			cursor: { kind: "folder", relativePath: "a/c" },
		});
		assert.equal(treeMotion(open, { kind: "folder", relativePath: "a" }, "Enter", false).type, "none");
	});
});

describe("isLibraryTrashKey", () => {
	it("uses command-backspace on mac and delete elsewhere", () => {
		const base = { key: "Backspace", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
		assert.equal(isLibraryTrashKey(base, true), true);
		assert.equal(isLibraryTrashKey(base, false), false);
		assert.equal(isLibraryTrashKey({ ...base, key: "Delete", metaKey: false }, false), true);
		assert.equal(isLibraryTrashKey({ ...base, key: "Delete", metaKey: false }, true), false);
		assert.equal(isLibraryTrashKey({ ...base, shiftKey: true }, true), false);
	});
});
