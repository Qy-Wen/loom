import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemPromptForLibrary } from "../src/main/agent-prompt.ts";

describe("systemPromptForLibrary", () => {
	it("names the open asset library as the working directory", () => {
		const prompt = systemPromptForLibrary("D:\\library");
		assert.match(prompt, /working directory, is D:\\library/);
		assert.match(prompt, /read, edit, write, and bash/);
		assert.match(prompt, /<asset_ref>/);
		assert.match(prompt, /<system-reminder>/);
		assert.match(prompt, /<ui_selection>/);
		assert.match(prompt, /Do not invent asset ids or paths/);
	});

	it("refuses to invent a directory when no library is open", () => {
		const prompt = systemPromptForLibrary(null);
		assert.match(prompt, /No asset library is open/);
		assert.doesNotMatch(prompt, /working directory, is /);
	});
});