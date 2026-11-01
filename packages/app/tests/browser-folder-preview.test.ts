import assert from "node:assert/strict";
import { test } from "node:test";
import type { Asset } from "@loom/core";
import { browserFolderPreviews } from "../src/renderer/workbench/browser-folder-preview.ts";

function asset(relativePath: string, type: Asset["type"]): Asset {
	return { assetId: relativePath, relativePath, filename: relativePath.split("/").at(-1)!, type, size: 1, createdAt: 0, modifiedAt: 0 };
}

test("empty folders have no preview, while a folder containing only subfolders is nonempty", () => {
	const previews = browserFolderPreviews({ folders: ["empty", "parent", "parent/child"], assets: [] });
	assert.equal(previews.get("empty"), undefined);
	assert.deepEqual(previews.get("parent"), { kind: "folder" });
	assert.equal(previews.get("parent/child"), undefined);
});

test("direct images and videos precede ordinary files and subfolders", () => {
	const image = asset("mixed/cover.png", "image");
	const video = asset("videos/clip.mp4", "video");
	const previews = browserFolderPreviews({
		folders: ["mixed/child", "videos/child"],
		assets: [asset("mixed/aaa.md", "text"), image, asset("videos/aaa.md", "text"), video],
	});
	assert.deepEqual(previews.get("mixed"), { kind: "asset", asset: image });
	assert.deepEqual(previews.get("videos"), { kind: "asset", asset: video });
});

test("media and file ties use name order independent of snapshot order", () => {
	const assets = [asset("mixed/z.png", "image"), asset("mixed/a.mp4", "video"), asset("docs/z.txt", "text"), asset("docs/a.wav", "audio")];
	const forward = browserFolderPreviews({ folders: ["docs/child"], assets });
	const backward = browserFolderPreviews({ folders: ["docs/child"], assets: [...assets].reverse() });
	assert.deepEqual(forward.get("mixed"), { kind: "asset", asset: assets[1] });
	assert.deepEqual(forward.get("docs"), { kind: "asset", asset: assets[3] });
	assert.deepEqual([...forward].sort(), [...backward].sort());
});

test("nested files do not become ancestor covers and similarly named folders stay separate", () => {
	const direct = asset("a/notes.md", "text");
	const nested = asset("a/deep/cover.png", "image");
	const sibling = asset("ab/cover.png", "image");
	const previews = browserFolderPreviews({ folders: ["a", "a/deep", "ab", "only", "only/child"], assets: [direct, nested, sibling, asset("only/child/a.png", "image")] });
	assert.deepEqual(previews.get("a"), { kind: "asset", asset: direct });
	assert.deepEqual(previews.get("a/deep"), { kind: "asset", asset: nested });
	assert.deepEqual(previews.get("ab"), { kind: "asset", asset: sibling });
	assert.deepEqual(previews.get("only"), { kind: "folder" });
});

test("rebuilding after additions and removals updates the cover without mutating the previous result", () => {
	const file = asset("folder/notes.md", "text");
	const image = asset("folder/cover.png", "image");
	const before = browserFolderPreviews({ folders: ["folder"], assets: [file] });
	const withImage = browserFolderPreviews({ folders: ["folder"], assets: [file, image] });
	assert.deepEqual(before.get("folder"), { kind: "asset", asset: file });
	assert.deepEqual(withImage.get("folder"), { kind: "asset", asset: image });
	assert.deepEqual(browserFolderPreviews({ folders: ["folder"], assets: [file] }).get("folder"), before.get("folder"));
	assert.equal(browserFolderPreviews({ folders: ["folder"], assets: [] }).get("folder"), undefined);
});
