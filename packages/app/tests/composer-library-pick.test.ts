import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { composerAssetsFromPickedFiles } from "../src/main/composer/composer-library-pick.ts";

const root = resolve("/tmp/loom-library");
const clip = { assetId: "asset-1", relativePath: "clips/hero.mp4", type: "video" as const };

describe("composerAssetsFromPickedFiles", () => {
	it("maps a library file to a chip draft", () => {
		assert.deepEqual(
			composerAssetsFromPickedFiles(root, [resolve(root, "clips/hero.mp4")], [clip]),
			[{ assetId: "asset-1", path: "clips/hero.mp4", assetType: "video" }],
		);
	});

	it("rejects a path outside the library", () => {
		assert.throws(
			() => composerAssetsFromPickedFiles(root, [resolve("/tmp/other/shot.png")], [clip]),
			/outside the library/,
		);
	});

	it("rejects a file that is not indexed", () => {
		assert.throws(
			() => composerAssetsFromPickedFiles(root, [resolve(root, "missing.png")], [clip]),
			/not in the library/,
		);
	});
});
