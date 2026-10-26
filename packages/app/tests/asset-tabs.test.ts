import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activateTab,
	closeTab,
	emptyAssetTabs,
	insertTabs,
	moveTab,
	openInNewTab,
	pruneTabs,
	showInTab,
	tabLabels,
	type AssetTabs,
} from "../src/renderer/workbench/asset-tabs.ts";

const tabs = (ids: string[], active: string | null): AssetTabs => ({ ids, active });

describe("asset tabs", () => {
	it("shows the first file in a new tab", () => {
		assert.deepEqual(showInTab(emptyAssetTabs, "a"), tabs(["a"], "a"));
	});

	it("replaces the active tab on a plain click, like following a link", () => {
		assert.deepEqual(showInTab(tabs(["a", "b", "c"], "b"), "d"), tabs(["a", "d", "c"], "d"));
	});

	it("switches to the tab that already has the file instead of duplicating it", () => {
		assert.deepEqual(showInTab(tabs(["a", "b"], "b"), "a"), tabs(["a", "b"], "a"));
		const same = tabs(["a", "b"], "a");
		assert.equal(showInTab(same, "a"), same);
	});

	it("opens a new tab right of the active one", () => {
		assert.deepEqual(openInNewTab(tabs(["a", "b", "c"], "a"), "d"), tabs(["a", "d", "b", "c"], "d"));
		assert.deepEqual(openInNewTab(tabs(["a", "b"], "b"), "c"), tabs(["a", "b", "c"], "c"));
		assert.deepEqual(openInNewTab(emptyAssetTabs, "a"), tabs(["a"], "a"));
	});

	it("does not duplicate a file when asked to open it in a new tab", () => {
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

	it("drops tabs whose file left the library and falls back to a neighbour", () => {
		assert.deepEqual(pruneTabs(tabs(["a", "b", "c"], "b"), (id) => id !== "b"), tabs(["a", "c"], "c"));
		assert.deepEqual(pruneTabs(tabs(["a", "b", "c"], "a"), (id) => id === "a"), tabs(["a"], "a"));
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
