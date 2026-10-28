import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assetKey,
	boxSelect,
	clearAssetSelection,
	contextSelection,
	emptyTreeSelection,
	extendSelection,
	folderKey,
	isLibraryTrashKey,
	pointerMode,
	pointerSelect,
	rootLibraryItems,
	selectVisible,
	singleSelection,
	treeMotion,
	visibleTreeRows,
	type TreeAssetRef,
	type TreeCursor,
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

	it("sorts folders by their newest file and files newest first", () => {
		const dated: TreeAssetRef[] = [
			{ assetId: "old", relativePath: "a/old.txt", modifiedAt: 10 },
			{ assetId: "new", relativePath: "b/new.txt", modifiedAt: 50 },
			{ assetId: "nested", relativePath: "a/c/nested.txt", modifiedAt: 40 },
			{ assetId: "mid", relativePath: "mid.txt", modifiedAt: 30 },
			{ assetId: "fresh", relativePath: "fresh.txt", modifiedAt: 60 },
		];
		assert.deepEqual(paths(visibleTreeRows(["b", "a", "a/c", "empty"], dated, new Set(), "modified", "desc")), [
			"b",
			"b/new.txt",
			"a",
			"a/c",
			"a/c/nested.txt",
			"a/old.txt",
			"empty",
			"fresh.txt",
			"mid.txt",
		]);
		assert.deepEqual(paths(visibleTreeRows(["b", "a", "a/c", "empty"], dated, new Set(), "modified", "asc")), [
			"empty",
			"a",
			"a/c",
			"a/c/nested.txt",
			"a/old.txt",
			"b",
			"b/new.txt",
			"mid.txt",
			"fresh.txt",
		]);
	});

	it("reverses each group when name order is descending", () => {
		assert.deepEqual(paths(visibleTreeRows(["b", "a"], [
			{ assetId: "m", relativePath: "m.txt" },
			{ assetId: "z", relativePath: "z.txt" },
		], new Set(), "name", "desc")), [
			"b",
			"a",
			"z.txt",
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

describe("pointer selection", () => {
	const rows = visibleTreeRows(["b", "a", "a/c"], assets, new Set(["a/c"]));
	const a = folderKey("a");
	const c = folderKey("a/c");
	const z = assetKey("z");

	it("toggles with the platform modifier and ranges from the anchor", () => {
		assert.equal(pointerMode({ shiftKey: false, metaKey: true, ctrlKey: false }, true), "toggle");
		assert.equal(pointerMode({ shiftKey: false, metaKey: false, ctrlKey: true }, true), "replace");
		assert.equal(pointerMode({ shiftKey: false, metaKey: false, ctrlKey: true }, false), "toggle");
		assert.equal(pointerMode({ shiftKey: true, metaKey: true, ctrlKey: false }, true), "range");

		const toggled = pointerSelect(singleSelection(a), rows, z, "toggle");
		assert.deepEqual(toggled.keys, [a, z]);
		assert.equal(pointerSelect(toggled, rows, z, "toggle").focus, a);

		const ranged = pointerSelect(singleSelection(a), rows, z, "range");
		assert.deepEqual(ranged.keys, [a, c, z]);
		assert.equal(ranged.anchor, a);
		assert.equal(ranged.focus, z);
	});

	it("extends with shift and selects every visible row", () => {
		const extended = extendSelection(singleSelection(a), rows, "ArrowDown");
		assert.deepEqual(extended.keys, [a, c]);
		assert.equal(extendSelection(extended, rows, "ArrowDown").focus, z);
		assert.deepEqual(selectVisible(emptyTreeSelection, rows).keys, [a, c, z, folderKey("b"), assetKey("m")]);
	});

	it("keeps an existing selection when the context row is already inside it", () => {
		const selection = pointerSelect(singleSelection(a), rows, z, "toggle");
		assert.equal(contextSelection(selection, z).keys.length, 2);
		assert.deepEqual(contextSelection(selection, folderKey("b")).keys, [folderKey("b")]);
	});

	it("drops nested items when a parent folder is selected", () => {
		const cursors: TreeCursor[] = [
			{ kind: "folder", relativePath: "a" },
			{ kind: "folder", relativePath: "a/c" },
			{ kind: "asset", assetId: "z", relativePath: "a/z.txt" },
			{ kind: "asset", assetId: "m", relativePath: "m.txt" },
		];
		assert.deepEqual(rootLibraryItems(cursors), { assetIds: ["m"], folders: ["a"] });
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

describe("box selection from the graph", () => {
	const picked = { keys: [assetKey("a"), folderKey("docs")], anchor: assetKey("a"), focus: assetKey("a") };

	it("replaces the selection without a modifier, folders included", () => {
		assert.deepEqual(boxSelect(picked, ["b", "c"], false), { keys: [assetKey("b"), assetKey("c")], anchor: assetKey("b"), focus: assetKey("c") });
	});

	it("adds to the selection with a modifier and keeps what was picked", () => {
		const next = boxSelect(picked, ["a", "b"], true);
		assert.deepEqual(next.keys, [assetKey("a"), folderKey("docs"), assetKey("b")], "a is not listed twice");
		assert.equal(next.focus, assetKey("b"));
		assert.equal(next.anchor, assetKey("a"), "the anchor stays");
	});

	it("a box over nothing clears when replacing and changes nothing when adding", () => {
		assert.deepEqual(boxSelect(picked, [], false), { keys: [], anchor: null, focus: null });
		assert.equal(boxSelect(picked, [], true), picked);
	});

	it("clearing drops the picked files and keeps folders", () => {
		assert.deepEqual(clearAssetSelection(picked), { keys: [folderKey("docs")], anchor: folderKey("docs"), focus: folderKey("docs") });
		assert.deepEqual(clearAssetSelection(singleSelection(assetKey("a"))), { keys: [], anchor: null, focus: null });
		const onlyFolder = singleSelection(folderKey("docs"));
		assert.equal(clearAssetSelection(onlyFolder), onlyFolder, "nothing to drop returns the same object");
		assert.equal(clearAssetSelection(emptyTreeSelection), emptyTreeSelection);
	});
});
