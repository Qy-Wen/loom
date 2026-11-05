import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemPromptForLibrary } from "../src/main/chat/agent-prompt.ts";

describe("systemPromptForLibrary", () => {
	it("names the open asset library as the working directory", () => {
		const prompt = systemPromptForLibrary("D:\\library");
		assert.match(prompt, /working directory, is D:\\library/);
		assert.match(prompt, /read, edit, write, and the available shell tool \(bash or powershell\)/);
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

	it("names the tag and favorite tools and the search filters", () => {
		const prompt = systemPromptForLibrary("D:\\library");
		for (const name of ["list_tags", "add_tag", "remove_tag", "set_favorite"]) assert.match(prompt, new RegExp(name), name);
		assert.match(prompt, /reuse an existing tag/);
		assert.match(prompt, /accept tags and favorite/);
	});

	it("prefers direct retrieval and considers delegation only for parallel independent tasks", () => {
		const prompt = systemPromptForLibrary("D:\\library");
		assert.match(prompt, /Use search_assets, deep_search_assets, and inspect_asset directly for normal library retrieval/);
		assert.match(prompt, /inspect that exact id first; do not search for the same asset/);
		assert.match(prompt, /use read on the relativePath returned by inspect_asset/);
		assert.match(prompt, /Consider run_retrieve_agent only when there are multiple independent retrieval tasks that can run in parallel/);
		assert.match(prompt, /For a single retrieval task, including a multi-step one, use search_assets, deep_search_assets, and inspect_asset directly/);
		assert.doesNotMatch(prompt, /You do not have search_assets or inspect_asset/);
	});

	it("tells the model when to use each search, what deep search cannot see, and that relations need inspect", () => {
		const prompt = systemPromptForLibrary("D:\\library");
		assert.match(prompt, /If you know a word the file or its name would contain, use search_assets: it matches those words only, needs no index, and sees every file/);
		assert.match(prompt, /only know what the content is about.* start with deep_search_assets: .* only sees indexed files/);
		assert.match(prompt, /Do not retry search_assets with guessed synonyms/);
		assert.match(prompt, /indexedCount is 0 or low/);
		assert.match(prompt, /Search does not follow relations/);
		assert.doesNotMatch(prompt, /linkedFrom/);
	});

	it("refuses to invent a directory when no library is open", () => {
		const prompt = systemPromptForLibrary(null);
		assert.match(prompt, /No asset library is open/);
		assert.doesNotMatch(prompt, /working directory, is /);
	});
});
