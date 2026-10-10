import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetTypeFromPath } from "../src/model/asset.ts";

describe("assetTypeFromPath", () => {
	it("classifies supported media extensions case-insensitively", () => {
		assert.equal(assetTypeFromPath("photo.JPG"), "image");
		assert.equal(assetTypeFromPath("scan.tiff"), "image");
		assert.equal(assetTypeFromPath("clip.MP4"), "video");
		assert.equal(assetTypeFromPath("voice.FLAC"), "audio");
		assert.equal(assetTypeFromPath("notes.MD"), "text");
	});

	it("falls back to other for unknown files", () => {
		assert.equal(assetTypeFromPath("archive.zip"), "other");
		assert.equal(assetTypeFromPath("README"), "other");
	});
});
