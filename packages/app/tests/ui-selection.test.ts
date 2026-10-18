import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getUiSelection, parseUiSelectionDraft, setUiSelection } from "../src/main/composer/ui-selection.ts";

describe("parseUiSelectionDraft", () => {
	it("accepts a library asset snapshot and rejects junk", () => {
		assert.deepEqual(
			parseUiSelectionDraft({ assetId: "a", path: "clips/hero.mp4", assetType: "video" }),
			{ assetId: "a", path: "clips/hero.mp4", assetType: "video" },
		);
		assert.equal(parseUiSelectionDraft(null), null);
		assert.equal(parseUiSelectionDraft({ assetId: "a", path: "x", assetType: "nope" }), null);
	});

	it("stores the last parsed snapshot", () => {
		setUiSelection(parseUiSelectionDraft({ assetId: "a", path: "a.md", assetType: "text" }));
		assert.equal(getUiSelection()?.assetId, "a");
		setUiSelection(null);
		assert.equal(getUiSelection(), null);
	});
});
