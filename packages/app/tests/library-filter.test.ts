import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Asset, LibrarySnapshot } from "@loom/core";
import { filterFavorites, filterLibrary, filterTags } from "../src/renderer/library/library-filter.ts";

function asset(assetId: string, relativePath: string): Asset {
	return { assetId, relativePath, filename: relativePath.split("/").at(-1)! } as Asset;
}

const library: LibrarySnapshot = {
	rootPath: "/lib",
	folders: ["posters", "posters/2024", "docs"],
	assets: [asset("a", "posters/2024/cat.png"), asset("b", "posters/dog.png"), asset("c", "docs/cat-notes.md"), asset("d", "root.txt")],
	favoriteAssetIds: ["c", "a", "gone"],
	tags: [{ tagId: "t1", name: "Animals" }, { tagId: "t2", name: "Misc" }] as LibrarySnapshot["tags"],
	assetTags: [{ tagId: "t1", assetId: "a" }, { tagId: "t1", assetId: "b" }, { tagId: "t2", assetId: "d" }] as LibrarySnapshot["assetTags"],
};

describe("filterLibrary", () => {
	it("returns the library untouched for a blank query", () => {
		assert.equal(filterLibrary(library, "  "), library);
	});

	it("keeps matching files with the folders that lead to them", () => {
		const result = filterLibrary(library, "CAT");
		assert.deepEqual(result.assets.map((item) => item.assetId), ["a", "c"]);
		assert.deepEqual([...result.folders].sort(), ["docs", "posters", "posters/2024"]);
	});

	it("keeps everything under a folder whose name matches", () => {
		const result = filterLibrary(library, "posters");
		assert.deepEqual(result.assets.map((item) => item.assetId), ["a", "b"]);
		assert.deepEqual([...result.folders].sort(), ["posters", "posters/2024"]);
	});
});

describe("filterFavorites", () => {
	it("keeps favorite order and skips files that are gone", () => {
		assert.deepEqual(filterFavorites(library, "").map((item) => item.assetId), ["c", "a"]);
	});

	it("filters by name or path", () => {
		assert.deepEqual(filterFavorites(library, "posters").map((item) => item.assetId), ["a"]);
	});
});

describe("filterTags", () => {
	it("lists every tag with its files for a blank query", () => {
		assert.deepEqual(filterTags(library, "").map(({ tag, files }) => [tag.tagId, files.map((item) => item.assetId)]), [["t1", ["a", "b"]], ["t2", ["d"]]]);
	});

	it("keeps all files of a tag whose name matches", () => {
		assert.deepEqual(filterTags(library, "animal").map(({ files }) => files.map((item) => item.assetId)), [["a", "b"]]);
	});

	it("narrows a tag to its matching files", () => {
		assert.deepEqual(filterTags(library, "dog").map(({ tag, files }) => [tag.tagId, files.map((item) => item.assetId)]), [["t1", ["b"]]]);
	});
});
