import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareAssistantContent } from "../src/shared/assistant-asset-refs.ts";

function block(assetId: string, path = "clips/hero.mp4"): string {
	return `<asset_ref>\npath: ${path}\nasset_id: ${assetId}\ntype: video\n</asset_ref>`;
}

const known = new Map([["a1", "hero.mp4"]]);

describe("prepareAssistantContent", () => {
	it("links a known id and leaves an unknown block as text", () => {
		const text = `看一下${block("a1")}，还有${block("nope", "clips/other.mp4")}`;
		const { markdown, rawTail } = prepareAssistantContent(text, known);
		assert.equal(rawTail, "");
		assert.equal(markdown, "看一下[hero.mp4](#loom-asset:a1)，还有&lt;asset_ref&gt;\npath: clips/other.mp4\nasset_id: nope\ntype: video\n&lt;/asset_ref&gt;");
	});

	it("keeps an unfinished block out of markdown", () => {
		const text = `找到了\n<asset_ref>\npath: clips/hero.mp4\nasset_id: a1`;
		const { markdown, rawTail } = prepareAssistantContent(text, known);
		assert.equal(markdown, "找到了\n");
		assert.equal(rawTail, "<asset_ref>\npath: clips/hero.mp4\nasset_id: a1");
		assert.equal(markdown.includes("#loom-asset"), false);
	});

	it("does not link a block whose path is outside the library", () => {
		const { markdown, rawTail } = prepareAssistantContent(block("a1", "/tmp/hero.mp4"), known);
		assert.equal(rawTail, "");
		assert.equal(markdown.includes("#loom-asset"), false);
		assert.equal(markdown.includes("&lt;asset_ref&gt;"), true);
		assert.equal(markdown.includes("asset_id: a1"), true);
	});
});
