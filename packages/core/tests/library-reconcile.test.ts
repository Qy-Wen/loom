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

	it("keeps the id when the file at a path gets a new identity, as after an atomic save or a restore", () => {
		const next = reconcileOpenAssets(
			[asset("doc", "doc.txt", "1:1")],
			[file("doc.txt", "1:9")],
			false,
		);
		assert.equal(next.length, 1);
		assert.equal(next[0]?.assetId, "doc");
		assert.equal(next[0]?.fileSystemId, "1:9");
	});

	it("does not give a recorded id to a path whose file moved elsewhere", () => {
		const next = reconcileOpenAssets(
			[asset("a", "a.txt", "1:1"), asset("b", "b.txt", "1:2")],
			[file("a.txt", "1:7"), file("c.txt", "1:1"), file("b.txt", "1:2")],
			false,
		);
		assert.equal(next.find((item) => item.relativePath === "c.txt")?.assetId, "a");
		assert.notEqual(next.find((item) => item.relativePath === "a.txt")?.assetId, "a");
		assert.equal(next.find((item) => item.relativePath === "b.txt")?.assetId, "b");
		assert.equal(new Set(next.map((item) => item.assetId)).size, 3);
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
