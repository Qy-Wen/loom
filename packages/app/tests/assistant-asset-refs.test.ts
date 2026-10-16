import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { prepareAssistantContent } from "../src/shared/assistant-asset-refs.ts";

const library = new Map([
	["asset-1", { path: "clips/hero.mp4" }],
	["asset-2", { path: "archive/hero.mp4" }],
]);

function block(path: string, assetId?: string, type?: string): string {
	const id = assetId === undefined ? "" : `asset_id: ${assetId}\n`;
	const kind = type === undefined ? "" : `type: ${type}\n`;
	return `<asset_ref>\npath: ${path}\n${id}${kind}</asset_ref>`;
}

describe("prepareAssistantContent", () => {
	it("links by asset id and shows the live path", () => {
		const text = `见 ${block("clips/old.mp4", "asset-2", "video")}`;
		const { markdown, rawTail } = prepareAssistantContent(text, library);
		assert.equal(rawTail, "");
		assert.equal(markdown, "见 [archive/hero.mp4](#loom-asset:asset-2)");
	});

	it("falls back to the path when the id is missing or unknown", () => {
		const missing = prepareAssistantContent(block("clips/hero.mp4", "gone", "video"), library);
		const empty = prepareAssistantContent(block("clips/hero.mp4", "", "video"), library);
		const pathOnly = prepareAssistantContent(block("clips/hero.mp4"), library);
		assert.equal(missing.markdown, "[clips/hero.mp4](#loom-asset:asset-1)");
		assert.equal(empty.markdown, "[clips/hero.mp4](#loom-asset:asset-1)");
		assert.equal(pathOnly.markdown, "[clips/hero.mp4](#loom-asset:asset-1)");
	});

	it("marks a block red when neither the id nor the path is in the library", () => {
		const { markdown, rawTail } = prepareAssistantContent(block("/tmp/hero.mp4", "gone", "video"), library);
		assert.equal(rawTail, "");
		assert.equal(markdown, "[/tmp/hero.mp4](#loom-missing:%2Ftmp%2Fhero.mp4)");
	});

	it("matches a windows path separator on fallback", () => {
		const { markdown } = prepareAssistantContent(block("clips\\hero.mp4"), library);
		assert.equal(markdown, "[clips/hero.mp4](#loom-asset:asset-1)");
	});

	it("reads the attribute form a model may write instead of the block", () => {
		const selfClosing = prepareAssistantContent('见 <asset_ref path="clips/old.mp4" asset_id="asset-2" type="video" />', library);
		const paired = prepareAssistantContent("<asset_ref path='clips/hero.mp4'></asset_ref>", library);
		assert.equal(selfClosing.rawTail, "");
		assert.equal(selfClosing.markdown, "见 [archive/hero.mp4](#loom-asset:asset-2)");
		assert.equal(paired.markdown, "[clips/hero.mp4](#loom-asset:asset-1)");
	});

	it("keeps an unfinished attribute tag out of markdown", () => {
		const { markdown, rawTail } = prepareAssistantContent('找到了 <asset_ref path="clips/hero.mp4"', library);
		assert.equal(markdown, "找到了 ");
		assert.equal(rawTail, '<asset_ref path="clips/hero.mp4"');
	});

	it("keeps an unfinished block out of markdown", () => {
		const text = "找到了\n<asset_ref>\npath: clips/hero.mp4";
		const { markdown, rawTail } = prepareAssistantContent(text, library);
		assert.equal(markdown, "找到了\n");
		assert.equal(rawTail, "<asset_ref>\npath: clips/hero.mp4");
	});

	it("leaves an older path tag untouched", () => {
		const text = "<asset_path_ref>clips/hero.mp4</asset_path_ref>";
		const { markdown } = prepareAssistantContent(text, library);
		assert.equal(markdown, text);
		assert.equal(markdown.includes("#loom-asset"), false);
	});
});
