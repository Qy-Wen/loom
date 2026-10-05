import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	AUTO_MEMORY_CHAR_LIMIT,
	applyAutoMemoryAction,
	libraryAutoMemoryFile,
	parseAutoMemoryEntries,
	readLibraryAutoMemory,
	systemPromptWithAutoMemory,
	updateLibraryAutoMemory,
} from "../src/library-auto-memory.ts";

test("systemPromptWithAutoMemory appends saved facts and skips an empty note", () => {
	assert.equal(systemPromptWithAutoMemory("Base.", ""), "Base.");
	const prompt = systemPromptWithAutoMemory("Base.", "user prefers concise titles");
	assert.match(prompt, /^Base\.\n\nAuto memory for this library/);
	assert.match(prompt, /user prefers concise titles$/);
	assert.deepEqual(parseAutoMemoryEntries("one\r\n§\r\ntwo\r\n"), ["one", "two"]);
});

test("add, replace, and remove keep a unique entry and refuse an overflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-auto-memory-"));
	try {
		assert.equal(await readLibraryAutoMemory(root), "");
		assert.match(await updateLibraryAutoMemory(root, { action: "add", content: "user prefers concise titles" }), /Saved/);
		assert.match(await updateLibraryAutoMemory(root, { action: "add", content: "user prefers concise titles" }), /Already saved/);
		assert.match(await updateLibraryAutoMemory(root, { action: "add", content: "titles are 16:9" }), /Saved/);
		assert.match(
			await updateLibraryAutoMemory(root, { action: "replace", old_text: "16:9", content: "titles are 9:16" }),
			/Replaced/,
		);
		const stored = await readFile(libraryAutoMemoryFile(root), "utf8");
		assert.match(stored, /titles are 9:16/);
		assert.doesNotMatch(stored, /16:9/);
		await assert.rejects(
			() => updateLibraryAutoMemory(root, { action: "remove", old_text: "titles" }),
			/More than one entry matches/,
		);
		assert.match(await readFile(libraryAutoMemoryFile(root), "utf8"), /titles are 9:16/);
		assert.match(await updateLibraryAutoMemory(root, { action: "remove", old_text: "9:16" }), /Removed/);
		assert.match(await updateLibraryAutoMemory(root, { action: "remove", old_text: "concise" }), /Removed/);

		const huge = "x".repeat(AUTO_MEMORY_CHAR_LIMIT);
		await updateLibraryAutoMemory(root, { action: "add", content: huge });
		await assert.rejects(
			() => updateLibraryAutoMemory(root, { action: "add", content: "one more fact" }),
			/Shorten an entry/,
		);
		assert.equal(await readFile(libraryAutoMemoryFile(root), "utf8"), huge);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("applyAutoMemoryAction reports the entries that were already saved when a change does not fit", () => {
	assert.throws(() => applyAutoMemoryAction(["short"], { action: "replace", oldText: "short", content: "y".repeat(AUTO_MEMORY_CHAR_LIMIT + 1) }), /Current entries/);
});
