import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileOpenAssets, type ReconcileDiskFile } from "../src/library/reconcile.ts";
import type { Asset } from "../src/model/asset.ts";

function asset(assetId: string, relativePath: string, fileSystemId: string): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").at(-1) ?? relativePath,
		type: "image",
		size: 1,
		createdAt: 1,
		modifiedAt: 1,
		fileSystemId,
	};
}

function file(relativePath: string, fileSystemId: string): ReconcileDiskFile {
	return {
		relativePath,
		filename: relativePath.split("/").at(-1) ?? relativePath,
		fileSystemId,
		size: 2,
		createdAt: 3,
		modifiedAt: 4,
	};
}

describe("reconcileOpenAssets", () => {
	it("follows a moved file and treats the old path as a new asset", () => {
		const next = reconcileOpenAssets(
			[asset("cover", "cover.jpg", "1:1")],
			[file("cover.jpg", "1:2"), file("z-archive/cover.jpg", "1:1")],
			false,
		);
		const archived = next.find((item) => item.relativePath === "z-archive/cover.jpg");
		const cover = next.find((item) => item.relativePath === "cover.jpg");
		assert.equal(archived?.assetId, "cover");
		assert.equal(archived?.fileSystemId, "1:1");
		assert.ok(cover);
		assert.notEqual(cover.assetId, "cover");
		assert.equal(cover.fileSystemId, "1:2");
	});

	it("swaps two files without dropping either id", () => {
		const next = reconcileOpenAssets(
			[asset("a", "a.jpg", "1:1"), asset("b", "b.jpg", "1:2")],
			[file("a.jpg", "1:2"), file("b.jpg", "1:1")],
			false,
		);
		assert.equal(next.find((item) => item.relativePath === "a.jpg")?.assetId, "b");
		assert.equal(next.find((item) => item.relativePath === "b.jpg")?.assetId, "a");
	});

	it("matches only by path after a volume change", () => {
		const next = reconcileOpenAssets(
			[asset("a", "a.jpg", "1:1")],
			[file("b.jpg", "9:9")],
			true,
		);
		assert.equal(next.length, 1);
		assert.equal(next[0]?.relativePath, "b.jpg");
		assert.notEqual(next[0]?.assetId, "a");
		assert.equal(next[0]?.fileSystemId, "9:9");
	});
});
