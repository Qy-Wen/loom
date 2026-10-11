import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Asset } from "@loom/core";
import {
	assetPreviewUrl,
	extensionOf,
	filenameStem,
	formatBytes,
	sortAssets,
} from "../src/renderer/assets/asset-utils.ts";

const asset = (assetId: string, relativePath: string, modifiedAt = 10): Asset => ({
	assetId,
	relativePath,
	filename: relativePath.split("/").at(-1) ?? relativePath,
	type: "other",
	size: 0,
	createdAt: 0,
	modifiedAt,
});

describe("asset display helpers", () => {
	it("formats byte sizes at binary boundaries", () => {
		assert.equal(formatBytes(1000), "1000 B");
		assert.equal(formatBytes(1024), "1.0 KB");
		assert.equal(formatBytes(1024 * 1024), "1.0 MB");
		assert.equal(formatBytes(1024 * 1024 * 1024), "1.0 GB");
	});

	it("extracts extensions and filename stems", () => {
		assert.equal(extensionOf("Hero.Final.JPG"), ".jpg");
		assert.equal(filenameStem("Hero.Final.JPG"), "Hero.Final");
		assert.equal(extensionOf("README"), "");
		assert.equal(filenameStem("README"), "README");
	});

	it("sorts a copy without mutating the input", () => {
		const input = [asset("b", "z.jpg"), asset("a", "a.jpg")];
		assert.deepEqual(sortAssets(input).map((item) => item.assetId), ["a", "b"]);
		assert.deepEqual(input.map((item) => item.assetId), ["b", "a"]);
	});

	it("builds an encoded, cache-busted asset URL", () => {
		assert.equal(assetPreviewUrl(asset("id with space", "a.jpg", 42)), "loom-asset://asset/id%20with%20space?v=42");
		assert.equal(assetPreviewUrl({ ...asset("id", "a.jpg", 42), size: 100 }), "loom-asset://asset/id?v=42-100");
	});
});
