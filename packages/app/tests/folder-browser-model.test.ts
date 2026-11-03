import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	browseListing,
	browserRows,
	existingLocation,
	folderCrumbs,
	gridMove,
	rectBetween,
	rectsIntersect,
	remapLocation,
	ROOT_LOCATION,
	sameLocation,
} from "../src/renderer/workbench/browser/folder-browser-model.ts";

function asset(assetId: string, relativePath: string, modifiedAt = 0): Asset {
	return { assetId, relativePath, filename: relativePath.split("/").at(-1)!, type: "image", size: 1, modifiedAt } as unknown as Asset;
}

const library: LibrarySnapshot = {
	rootPath: "/lib",
	folders: ["a", "a/deep", "b"],
	assets: [
		asset("1", "top.png"),
		asset("2", "a/one.png"),
		asset("3", "a/deep/two.png"),
		asset("4", "b/three.png"),
		asset("5", "a/deep/sunset.png"),
	],
	favoriteAssetIds: ["2", "4"],
	tags: [{ tagId: "t", name: "Picked" }],
	assetTags: [{ assetId: "3", tagId: "t" }],
} as unknown as LibrarySnapshot;

const names = (listing: ReturnType<typeof browseListing>) => [...listing.folders, ...listing.assets.map((item) => item.relativePath)];

describe("browseListing", () => {
	it("shows direct children, folders first", () => {
		assert.deepEqual(names(browseListing(library, ROOT_LOCATION, "", "name", "asc")), ["a", "b", "top.png"]);
		assert.deepEqual(names(browseListing(library, { kind: "folder", path: "a" }, "", "name", "asc")), ["a/deep", "a/one.png"]);
	});

	it("searches everything below the folder by path, not above it", () => {
		const inA = browseListing(library, { kind: "folder", path: "a" }, "two", "name", "asc");
		assert.deepEqual(names(inA), ["a/deep/two.png"]);
		assert.deepEqual(names(browseListing(library, { kind: "folder", path: "b" }, "two", "name", "asc")), []);
		assert.deepEqual(names(browseListing(library, ROOT_LOCATION, "deep", "name", "asc")), ["a/deep", "a/deep/sunset.png", "a/deep/two.png"]);
	});

	it("does not match the folder's own path", () => {
		assert.deepEqual(names(browseListing(library, { kind: "folder", path: "a" }, "a/", "name", "asc")), []);
		assert.deepEqual(names(browseListing(library, { kind: "folder", path: "a" }, "  ", "name", "asc")), ["a/deep", "a/one.png"]);
	});

	it("lists favorites and tag files, filtered by the query", () => {
		assert.deepEqual(names(browseListing(library, { kind: "favorites" }, "", "name", "asc")), ["a/one.png", "b/three.png"]);
		assert.deepEqual(names(browseListing(library, { kind: "favorites" }, "three", "name", "asc")), ["b/three.png"]);
		assert.deepEqual(names(browseListing(library, { kind: "tag", tagId: "t" }, "", "name", "asc")), ["a/deep/two.png"]);
	});

	it("sorts by modified time, newest first when descending", () => {
		const timed = { ...library, assets: [asset("1", "x.png", 1), asset("2", "y.png", 3), asset("3", "z.png", 2)], folders: [] };
		assert.deepEqual(names(browseListing(timed, ROOT_LOCATION, "", "modified", "desc")), ["y.png", "z.png", "x.png"]);
	});

	it("lists tags as virtual folders, searching names without listing their files", () => {
		const tagged = { ...library, tags: [{ tagId: "b", name: "Work / drafts" }, { tagId: "a", name: "Picked" }] };
		const listing = browseListing(tagged, { kind: "tags" }, "", "name", "asc");
		assert.deepEqual(listing.tags.map((tag) => tag.tagId), ["a", "b"]);
		assert.deepEqual(listing.assets, []);
		assert.deepEqual(listing.folders, []);
		assert.deepEqual(browserRows(listing), []); // Virtual tags never become filesystem selection rows.
		assert.deepEqual(browseListing(tagged, { kind: "tags" }, " DRAFTS ", "name", "asc").tags, [tagged.tags[0]]);
		assert.deepEqual(browseListing(tagged, { kind: "tags" }, "two.png", "name", "asc").tags, []);
		assert.deepEqual(browseListing(tagged, { kind: "tags" }, "", "name", "desc").tags.map((tag) => tag.tagId), ["b", "a"]);
	});

	it("sorts tag folders by the newest file in each tag", () => {
		const tagged = {
			...library,
			tags: [{ tagId: "a", name: "A" }, { tagId: "b", name: "B" }],
			assets: [asset("old", "old.png", 1), asset("new", "new.png", 3), asset("middle", "middle.png", 2)],
			assetTags: [{ assetId: "old", tagId: "a", createdAt: 0 }, { assetId: "new", tagId: "a", createdAt: 0 }, { assetId: "middle", tagId: "b", createdAt: 0 }],
		};
		assert.deepEqual(browseListing(tagged, { kind: "tags" }, "", "modified", "desc").tags.map((tag) => tag.tagId), ["a", "b"]);
		assert.deepEqual(browseListing(tagged, { kind: "tags" }, "", "modified", "asc").tags.map((tag) => tag.tagId), ["b", "a"]);
	});
});

describe("browserRows", () => {
	it("orders folders before files, as the grid paints them", () => {
		const rows = browserRows(browseListing(library, ROOT_LOCATION, "", "name", "asc"));
		assert.deepEqual(rows.map((row) => `${row.kind}:${row.relativePath}`), ["folder:a", "folder:b", "asset:top.png"]);
		assert.equal(rows[2].assetId, "1");
	});
});

describe("gridMove", () => {
	it("moves by one across and by a row down", () => {
		assert.equal(gridMove(0, "ArrowRight", 3, 8), 1);
		assert.equal(gridMove(1, "ArrowLeft", 3, 8), 0);
		assert.equal(gridMove(1, "ArrowDown", 3, 8), 4);
		assert.equal(gridMove(4, "ArrowUp", 3, 8), 1);
	});

	it("stops at the edges", () => {
		assert.equal(gridMove(0, "ArrowLeft", 3, 8), 0);
		assert.equal(gridMove(7, "ArrowRight", 3, 8), 7);
		assert.equal(gridMove(1, "ArrowUp", 3, 8), 1);
		assert.equal(gridMove(7, "ArrowDown", 3, 8), 7);
	});

	it("lands on the last tile of a short final row", () => {
		assert.equal(gridMove(5, "ArrowDown", 3, 8), 7);
		assert.equal(gridMove(2, "ArrowDown", 3, 4), 3);
	});

	it("starts from an end when nothing is focused", () => {
		assert.equal(gridMove(-1, "ArrowDown", 3, 8), 0);
		assert.equal(gridMove(-1, "ArrowUp", 3, 8), 7);
		assert.equal(gridMove(3, "Home", 3, 8), 0);
		assert.equal(gridMove(3, "End", 3, 8), 7);
		assert.equal(gridMove(0, "ArrowDown", 3, 0), -1);
	});
});

describe("box geometry", () => {
	it("builds the rectangle whichever way it was dragged", () => {
		assert.deepEqual(rectBetween(10, 40, 4, 8), { x: 4, y: 8, width: 6, height: 32 });
	});

	it("intersects on overlap only, not on shared edges", () => {
		const box = { x: 0, y: 0, width: 10, height: 10 };
		assert.equal(rectsIntersect(box, { x: 9, y: 9, width: 5, height: 5 }), true);
		assert.equal(rectsIntersect(box, { x: 10, y: 0, width: 5, height: 5 }), false);
		assert.equal(rectsIntersect(box, { x: 20, y: 20, width: 5, height: 5 }), false);
	});
});

describe("locations", () => {
	it("follows a renamed folder and the ones inside it", () => {
		assert.deepEqual(remapLocation({ kind: "folder", path: "a/deep" }, "a", "z"), { kind: "folder", path: "z/deep" });
		assert.deepEqual(remapLocation({ kind: "folder", path: "ab" }, "a", "z"), { kind: "folder", path: "ab" });
		assert.deepEqual(remapLocation({ kind: "favorites" }, "a", "z"), { kind: "favorites" });
	});

	it("falls back to the nearest folder that still exists", () => {
		assert.deepEqual(existingLocation({ kind: "folder", path: "a/gone/deeper" }, library), { kind: "folder", path: "a" });
		assert.deepEqual(existingLocation({ kind: "folder", path: "gone" }, library), ROOT_LOCATION);
		assert.deepEqual(existingLocation({ kind: "tag", tagId: "nope" }, library), { kind: "tags" });
		const kept = { kind: "folder", path: "a/deep" } as const;
		assert.equal(existingLocation(kept, library), kept);
	});

	it("keeps the tag directory even when the last tag is removed", () => {
		assert.deepEqual(existingLocation({ kind: "tags" }, { folders: [], tags: [] }), { kind: "tags" });
		assert.equal(sameLocation({ kind: "tags" }, { kind: "tags" }), true);
		assert.equal(sameLocation({ kind: "tags" }, { kind: "tag", tagId: "t" }), false);
	});

	it("builds crumbs from the root down", () => {
		assert.deepEqual(folderCrumbs("a/deep"), [{ name: "a", path: "a" }, { name: "deep", path: "a/deep" }]);
		assert.deepEqual(folderCrumbs(""), []);
	});
});
