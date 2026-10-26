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

	it("ignores everything under .loom and Finder metadata, but not a user's .agents folder", () => {
		assert.equal(paths.isIgnoredPath(join(root, ".loom", "metadata-db", "metadata.db")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".loom", "agents", "memory", "MEMORY.md")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".loom", "agents", "skills", "voice", "SKILL.md")), true);
		assert.equal(paths.isIgnoredPath(join(root, ".agents", "notes.md")), false);
		assert.equal(paths.isIgnoredPath(join(root, ".DS_Store")), true);
		assert.equal(paths.isIgnoredPath(join(root, "nested", ".DS_Store")), true);
		assert.equal(paths.isIgnoredPath(join(root, "hero.jpg")), false);
	});

	it("places every Loom-owned file under .loom", () => {
		for (const path of [paths.metadataDb, paths.graphDb, paths.gradeRecords, paths.gradeLuts, paths.sessionsDb, paths.commandAllows, paths.skills, paths.memoryFile, paths.traces, paths.toolResults]) {
			assert.equal(paths.isLoomPath(path), true, path);
		}
		assert.equal(paths.toRelativePath(paths.metadataDb), ".loom/metadata-db/metadata.db");
		assert.equal(paths.toRelativePath(paths.graphDb), ".loom/graph-db/graph.db");
		assert.equal(paths.toRelativePath(paths.sessionsDb), ".loom/agents/sessions/loom.sqlite");
		assert.equal(paths.toRelativePath(paths.commandAllows), ".loom/agents/command-allows/command-allows.json");
		assert.equal(paths.toRelativePath(paths.skills), LibraryPaths.SKILLS_RELATIVE);
	});
});
