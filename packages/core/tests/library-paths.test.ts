import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";
import { LibraryPaths } from "../src/library/paths.ts";

describe("LibraryPaths", () => {
	const root = resolve("/tmp/loom-library-paths");
	const paths = new LibraryPaths(root);

	it("converts library paths without leaking platform separators", () => {
		assert.equal(paths.toRelativePath(join(root, "campaign", "hero.jpg")), "campaign/hero.jpg");
		assert.equal(paths.toAbsolutePath("campaign/hero.jpg"), join(root, "campaign", "hero.jpg"));
	});

	it("rejects the root and paths outside the library", () => {
		assert.throws(() => paths.toRelativePath(root), /outside the library/);
		assert.throws(() => paths.toRelativePath(resolve(root, "..", "secret.txt")), /outside the library/);
		assert.throws(() => paths.toAbsolutePath("../secret.txt"), /outside the library/);
		assert.throws(() => paths.toAbsolutePath(resolve(root, "hero.jpg")), /relative/);
	});

	it("ignores Loom metadata, the agent directory, and Finder metadata", () => {
		assert.equal(paths.isIgnoredPath(join(root, ".loom", "metadata.db")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".loom", "sessions", "chat.jsonl")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".loom", "harness-sessions", "chat.jsonl")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".agents")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".agents", "memory", "MEMORY.md")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".agents", "skills", "voice", "SKILL.md")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".DS_Store")), true);
		assert.equal(paths.isIgnoredPath(join(root, "nested", ".DS_Store")), true);
		assert.equal(paths.isIgnoredPath(join(root, "hero.jpg")), false);
	});
});
