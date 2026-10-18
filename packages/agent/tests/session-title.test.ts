import { DEFAULT_SESSION_TITLE, titleFromUserText } from "../src/runtime/session-title.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("session titles", () => {
	it("builds a compact title from the first user text", () => {
		assert.equal(titleFromUserText("  clip   this  "), "clip this");
		const block = "<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>";
		assert.equal(titleFromUserText(`看一下${block}这段`), "看一下这段");
		assert.equal(titleFromUserText("x".repeat(50)).endsWith("…"), true);
		assert.equal(titleFromUserText(" \n  "), DEFAULT_SESSION_TITLE);
	});
});
