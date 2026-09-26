import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	LastLibraryStore,
	lastLibraryStillOpenable,
	parseLastLibrary,
} from "../src/main/last-library-store.ts";

describe("parseLastLibrary", () => {
	it("reads a non-empty rootPath", () => {
		assert.equal(parseLastLibrary({ rootPath: "/data/Assets" }), "/data/Assets");
		assert.equal(parseLastLibrary({ rootPath: "  /tmp/lib  " }), "/tmp/lib");
	});

	it("rejects missing or empty paths", () => {
		assert.equal(parseLastLibrary(null), null);
		assert.equal(parseLastLibrary({}), null);
		assert.equal(parseLastLibrary({ rootPath: "" }), null);
		assert.equal(parseLastLibrary({ rootPath: "   " }), null);
		assert.equal(parseLastLibrary({ rootPath: 12 }), null);
	});
});

describe("LastLibraryStore", () => {
	it("persists the last root and skips a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-last-lib-"));
		const missing = new LastLibraryStore(join(dir, "missing.json"));
		assert.equal(await missing.load(), null);

		const store = new LastLibraryStore(join(dir, "last-library.json"));
		await store.remember("/Users/me/Library");
		assert.equal(await store.load(), "/Users/me/Library");

		const again = new LastLibraryStore(join(dir, "last-library.json"));
		assert.equal(await again.load(), "/Users/me/Library");
	});
});

describe("lastLibraryStillOpenable", () => {
	it("is true only for an existing directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-last-lib-open-"));
		assert.equal(await lastLibraryStillOpenable(dir), true);
		assert.equal(await lastLibraryStillOpenable(join(dir, "gone")), false);

		const file = join(dir, "not-a-folder.txt");
		await writeFile(file, "nope");
		assert.equal(await lastLibraryStillOpenable(file), false);

		await mkdir(join(dir, "nested"));
		assert.equal(await lastLibraryStillOpenable(join(dir, "nested")), true);
	});
});
