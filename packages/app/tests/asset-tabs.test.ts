import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activateTab,
	closeTab,
	emptyAssetTabs,
	insertTabs,
	setTabPinned,
	moveTab,
	openInNewTab,
	pruneTabs,
	showPreviewTab,
	tabLabels,
	type AssetTabs,
} from "../src/renderer/workbench/asset-tabs.ts";

const tabs = (ids: string[], active: string | null, ...previews: string[]): AssetTabs => ({ ids, active, previews });

describe("asset tabs", () => {
	it("opens the preview beside the active pinned tab", () => {
		assert.deepEqual(showPreviewTab(emptyAssetTabs, "a"), tabs(["a"], "a", "a"));
		assert.deepEqual(showPreviewTab(tabs(["a", "b"], "a"), "c"), tabs(["a", "c", "b"], "c", "c"));
	});

	it("replaces the preview in place even when a pinned tab is active", () => {
		assert.deepEqual(showPreviewTab(tabs(["a", "b", "c"], "c", "b"), "d"), tabs(["a", "d", "c"], "d", "d"));
	});

	it("activates an existing tab and retains the preview", () => {
		assert.deepEqual(showPreviewTab(tabs(["a", "b"], "b", "b"), "a"), tabs(["a", "b"], "a", "b"));
		assert.deepEqual(showPreviewTab(tabs(["a", "b"], "a", "b"), "b"), tabs(["a", "b"], "b", "b"));
		const same = tabs(["a", "b"], "b", "b");
		assert.equal(showPreviewTab(same, "b"), same);
	});

	it("pins the preview without activating it and ignores a stale menu choice", () => {
		const current = tabs(["a", "b"], "a", "b");
		assert.deepEqual(setTabPinned(current, "b", true), tabs(["a", "b"], "a"));
		assert.equal(setTabPinned(current, "a", true), current);
		assert.equal(setTabPinned(current, "missing", false), current);
	});

	it("unpins in place and replaces only the most recently viewed preview", () => {
		const current = tabs(["a", "b"], "b", "b");
		const both = setTabPinned(current, "a", false);
		assert.deepEqual(both, tabs(["a", "b"], "b", "a", "b"));
		assert.deepEqual(showPreviewTab(both, "c"), tabs(["a", "c"], "c", "a", "c"));
		assert.deepEqual(showPreviewTab(activateTab(both, "a"), "c"), tabs(["c", "b"], "c", "b", "c"));
		assert.deepEqual(setTabPinned(tabs(["a", "b"], "a", "b"), "a", false), tabs(["a", "b"], "a", "b", "a"));
	});

	it("opens a new tab right of the active one", () => {
		assert.deepEqual(openInNewTab(tabs(["a", "b", "c"], "a"), "d"), tabs(["a", "d", "b", "c"], "d"));
		assert.deepEqual(openInNewTab(tabs(["a", "b"], "b"), "c"), tabs(["a", "b", "c"], "c"));
		assert.deepEqual(openInNewTab(emptyAssetTabs, "a"), tabs(["a"], "a"));
		assert.deepEqual(openInNewTab(tabs(["a"], "a", "a"), "b"), tabs(["a", "b"], "b", "a"));
	});

	it("opens a separate preview and reuses it on the next ordinary open", () => {
		const current = tabs(["a", "b", "c"], "b", "b");
		const next = openInNewTab(current, "d", "preview");
		assert.deepEqual(next, tabs(["a", "b", "d", "c"], "d", "b", "d"));
		assert.deepEqual(showPreviewTab(next, "e"), tabs(["a", "b", "e", "c"], "e", "b", "e"));
	});

	it("keeps an existing tab's pin state when asked to open a preview", () => {
		const current = tabs(["a", "b", "c"], "c", "b", "c");
		assert.deepEqual(openInNewTab(current, "a", "preview"), tabs(["a", "b", "c"], "a", "b", "c"));
		assert.deepEqual(openInNewTab(current, "b", "preview"), tabs(["a", "b", "c"], "b", "c", "b"));
	});

	it("pins a preview in place and activates existing pinned tabs", () => {
		assert.deepEqual(openInNewTab(tabs(["a", "b"], "a", "b"), "b"), tabs(["a", "b"], "b"));
		assert.deepEqual(openInNewTab(tabs(["a", "b"], "a"), "b"), tabs(["a", "b"], "b"));
	});

	it("activates only tabs that exist", () => {
		const current = tabs(["a", "b"], "a");
		assert.deepEqual(activateTab(current, "b"), tabs(["a", "b"], "b"));
		assert.equal(activateTab(current, "x"), current);
		assert.equal(activateTab(current, "a"), current);
	});

	it("closes the active tab to its right neighbour, or the left one when it was last", () => {
		assert.deepEqual(closeTab(tabs(["a", "b", "c"], "b"), "b"), tabs(["a", "c"], "c"));
		assert.deepEqual(closeTab(tabs(["a", "b", "c"], "c"), "c"), tabs(["a", "b"], "b"));
		assert.deepEqual(closeTab(tabs(["a"], "a"), "a"), emptyAssetTabs);
	});

	it("keeps the active tab when another one closes", () => {
		assert.deepEqual(closeTab(tabs(["a", "b", "c"], "c"), "a"), tabs(["b", "c"], "c"));
		assert.deepEqual(closeTab(tabs(["a", "b"], "a", "b"), "b"), tabs(["a"], "a"));
		assert.deepEqual(closeTab(tabs(["a", "b"], "a", "b"), "a"), tabs(["b"], "b", "b"));
		const current = tabs(["a"], "a");
		assert.equal(closeTab(current, "x"), current);
	});

	it("moves a tab before another one without changing the active tab", () => {
		assert.deepEqual(moveTab(tabs(["a", "b", "c", "d"], "b"), "d", "b"), tabs(["a", "d", "b", "c"], "b"));
		assert.deepEqual(moveTab(tabs(["a", "b", "c", "d"], "a"), "a", "d"), tabs(["b", "c", "a", "d"], "a"));
		assert.deepEqual(moveTab(tabs(["a", "b", "c"], "c"), "c", "a"), tabs(["c", "a", "b"], "c"));
	});

	it("moves a tab to the end when dropped after the last one", () => {
		assert.deepEqual(moveTab(tabs(["a", "b", "c"], "a"), "a", null), tabs(["b", "c", "a"], "a"));
	});

	it("leaves the tabs alone for a move that changes nothing", () => {
		const current = tabs(["a", "b", "c"], "b");
		assert.equal(moveTab(current, "b", "b"), current);
		assert.equal(moveTab(current, "a", "b"), current);
		assert.equal(moveTab(current, "c", null), current);
		assert.equal(moveTab(current, "x", "a"), current);
		assert.equal(moveTab(current, "a", "x"), current);
	});

	it("opens dropped files as tabs at the drop position and shows the first one", () => {
		assert.deepEqual(insertTabs(emptyAssetTabs, ["x", "y"], null), tabs(["x", "y"], "x"));
		assert.deepEqual(insertTabs(tabs(["a", "b", "c"], "a"), ["x", "y"], "b"), tabs(["a", "x", "y", "b", "c"], "x"));
		assert.deepEqual(insertTabs(tabs(["a", "b", "c"], "a"), ["x"], null), tabs(["a", "b", "c", "x"], "x"));
	});

	it("moves a dropped file that is already open instead of duplicating it", () => {
		assert.deepEqual(insertTabs(tabs(["a", "b", "c"], "a"), ["c"], "a"), tabs(["c", "a", "b"], "c"));
		assert.deepEqual(insertTabs(tabs(["a", "b", "c"], "b"), ["a"], "a"), tabs(["a", "b", "c"], "a"));
		assert.deepEqual(insertTabs(tabs(["a", "b", "c"], "a"), ["x", "b"], "c"), tabs(["a", "x", "b", "c"], "x"));
	});

	it("ignores duplicate ids and an empty drop", () => {
		assert.deepEqual(insertTabs(tabs(["a"], "a"), ["x", "x"], null), tabs(["a", "x"], "x"));
		const current = tabs(["a"], "a");
		assert.equal(insertTabs(current, [], null), current);
	});

	it("pins a dropped preview and preserves an unrelated preview", () => {
		const current = tabs(["a", "b"], "b", "a");
		assert.deepEqual(insertTabs(current, ["a"], null), tabs(["b", "a"], "a"));
		assert.deepEqual(insertTabs(current, ["c"], null), tabs(["a", "b", "c"], "c", "a"));
	});

	it("drops tabs whose file left the library and falls back to a neighbour", () => {
		assert.deepEqual(pruneTabs(tabs(["a", "b", "c"], "b"), (id) => id !== "b"), tabs(["a", "c"], "c"));
		assert.deepEqual(pruneTabs(tabs(["a", "b", "c"], "a"), (id) => id === "a"), tabs(["a"], "a"));
		assert.deepEqual(pruneTabs(tabs(["a", "b"], "a", "a"), (id) => id === "b"), tabs(["b"], "b"));
		assert.deepEqual(pruneTabs(tabs(["a", "b"], "a"), () => false), emptyAssetTabs);
		const current = tabs(["a", "b"], "a");
		assert.equal(pruneTabs(current, () => true), current);
	});

	it("adds the folder to a name that two open tabs share", () => {
		const labels = tabLabels([
			{ assetId: "1", filename: "cover.png", relativePath: "a/cover.png" },
			{ assetId: "2", filename: "cover.png", relativePath: "b/c/cover.png" },
			{ assetId: "3", filename: "notes.md", relativePath: "notes.md" },
			{ assetId: "4", filename: "cover.png", relativePath: "cover.png" },
		]);
		assert.equal(labels.get("1"), "cover.png · a");
		assert.equal(labels.get("2"), "cover.png · b/c");
		assert.equal(labels.get("3"), "notes.md");
		assert.equal(labels.get("4"), "cover.png");
	});
});
