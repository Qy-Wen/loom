import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LibraryPaths } from "../src/library/paths.ts";
import { SqliteMetadataStore } from "../src/stores/sqlite.ts";

test("opening a library records whether sqlite-vec loaded", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-sqlite-vec-"));
	const store = new SqliteMetadataStore();
	try {
		assert.equal(store.sqliteVecNote(), undefined);
		await store.open(new LibraryPaths(root));
		assert.match(store.sqliteVecNote() ?? "", /^sqlite-vec /);
		await store.close();
		assert.equal(store.sqliteVecNote(), undefined);
	} finally {
		await store.close();
		await rm(root, { recursive: true, force: true });
	}
});
