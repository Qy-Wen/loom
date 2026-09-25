import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertEntryName,
	copyFilename,
	joinRelative,
	parentRelative,
	posixBasename,
	rewriteRelativePrefix,
	wouldNestInside,
} from "../src/library/names.ts";

test("library-relative names reject path separators and reserved folders", () => {
	assert.equal(assertEntryName("  Briefs  "), "Briefs");
	assert.throws(() => assertEntryName("a/b"), /valid name/);
	assert.throws(() => assertEntryName("."), /valid name/);
	assert.throws(() => assertEntryName(".loom"), /reserved/);
});

test("library-relative paths join, split, and rewrite without node:path", () => {
	assert.equal(joinRelative("", "notes"), "notes");
	assert.equal(joinRelative("notes", "drafts"), "notes/drafts");
	assert.equal(parentRelative("notes/drafts/a.md"), "notes/drafts");
	assert.equal(parentRelative("cover.jpg"), "");
	assert.equal(posixBasename("notes/drafts"), "drafts");
	assert.equal(rewriteRelativePrefix("notes/a.md", "notes", "briefs"), "briefs/a.md");
	assert.equal(rewriteRelativePrefix("notes", "notes", "briefs"), "briefs");
	assert.equal(rewriteRelativePrefix("other/a.md", "notes", "briefs"), undefined);
	assert.equal(wouldNestInside("notes", "notes"), true);
	assert.equal(wouldNestInside("notes", "notes/sub"), true);
	assert.equal(wouldNestInside("notes", "archive"), false);
	assert.equal(copyFilename("hero", ".jpg", 1), "hero copy.jpg");
	assert.equal(copyFilename("hero", ".jpg", 2), "hero copy 2.jpg");
});
