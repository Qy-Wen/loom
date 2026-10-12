import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemPromptForLibrary } from "../src/main/agent-prompt.ts";

describe("systemPromptForLibrary", () => {
	it("names the open asset library as the working directory", () => {
		const prompt = systemPromptForLibrary("D:\\library");
		assert.match(prompt, /working directory, is D:\\library/);
		assert.match(prompt, /read, edit, write, and bash/);
		assert.match(prompt, /<asset_ref>/);
		assert.match(prompt, /Omit asset_id when you do not have one/);
		assert.match(prompt, /<system-reminder>/);
		assert.match(prompt, /<ui_selection>/);
		assert.match(prompt, /Pass the full question in goal, including asset ids from <asset_ref> or <ui_selection>/);
		assert.match(prompt, /Do not invent paths or ids/);
		assert.match(prompt, /create_relation/);
		assert.match(prompt, /list_properties/);
		assert.match(prompt, /set_asset_property/);
		assert.match(prompt, /Media tools do not create relations/);
	});

	it("refuses to invent a directory when no library is open", () => {
		const prompt = systemPromptForLibrary(null);
		assert.match(prompt, /No asset library is open/);
		assert.doesNotMatch(prompt, /working directory, is /);
	});
});