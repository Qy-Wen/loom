import { DEFAULT_SESSION_TITLE, titleFromUserText } from "../src/session-title.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("session titles", () => {
	it("builds a compact title from the first user text", () => {
		assert.equal(titleFromUserText("  clip   this  "), "clip this");
		assert.equal(titleFromUserText("x".repeat(50)).endsWith("…"), true);
		assert.equal(titleFromUserText(" \n  "), DEFAULT_SESSION_TITLE);
	});
});
