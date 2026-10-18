import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCore } from "../src/index.ts";
import type { Asset, AssetType } from "../src/model/asset.ts";
import type { NearestChildHit } from "../src/model/hybrid.ts";
import { toSearchItem, type AssetSearchItem } from "../src/model/retrieval.ts";
import { expandSearchCandidates, SEARCH_NEIGHBORS_PER_SEED } from "../src/retrieval/graph.ts";
import type { AssetRelation } from "../src/index.ts";

function asset(assetId: string, relativePath: string, type: AssetType = "image"): Asset {
	const filename = relativePath.split("/").pop() ?? relativePath;
	return { assetId, relativePath, filename, type, size: 1, createdAt: 1, modifiedAt: 1 };
}

function seed(item: Asset): AssetSearchItem {
	return toSearchItem(item, []);
}

function relation(fromAssetId: string, toAssetId: string, type: string): AssetRelation {
	return { relationId: `${fromAssetId}:${toAssetId}:${type}`, fromAssetId, toAssetId, type };
}

test("expandSearchCandidates walks one hop and keeps the list unique", () => {
	const clip = asset("clip", "clip.mp4", "video");
	const frame = asset("frame", "frame.jpg");
	const still = asset("still", "still.jpg");
	const assetsById = new Map([clip, frame, still].map((item) => [item.assetId, item]));
	const passages = new Map<string, NearestChildHit>([
		["frame", { chunkId: "c1", assetId: "frame", parentId: "p1", text: "a dock", parentText: "parent dock" }],
	]);
	const expanded = expandSearchCandidates(
		[seed(clip)],
		[
			relation("frame", "clip", "zeta"),
			relation("frame", "clip", "alpha"),
			relation("clip", "still", "reference"),
			relation("clip", "missing", "gone"),
		],
		assetsById,
		new Map(),
		passages,
	);
	assert.deepEqual(expanded.map((item) => item.assetId), ["clip", "frame", "still"]);
	assert.equal(expanded[0]?.linkedFrom, undefined);
	assert.equal(expanded[1]?.linkedFrom?.relationType, "alpha");
	assert.equal(expanded[1]?.linkedFrom?.direction, "in");
	assert.equal(expanded[1]?.linkedFrom?.assetId, "clip");
	assert.equal(expanded[1]?.passage, "a dock");
	assert.equal(expanded[1]?.parentPassage, "parent dock");
	assert.equal(expanded[2]?.linkedFrom?.direction, "out");
	assert.equal(expanded[2]?.linkedFrom?.relationType, "reference");
	assert.equal(expanded[2]?.passage, undefined);
});

test("expandSearchCandidates claims a shared neighbor from the earlier seed", () => {
	const first = asset("first", "first.md", "text");
	const second = asset("second", "second.md", "text");
	const shared = asset("shared", "shared.jpg");
	const assetsById = new Map([first, second, shared].map((item) => [item.assetId, item]));
	const expanded = expandSearchCandidates(
		[seed(first), seed(second)],
		[relation("first", "shared", "uses"), relation("second", "shared", "uses")],
		assetsById,
		new Map(),
		new Map(),
	);
	assert.deepEqual(expanded.map((item) => item.assetId), ["first", "second", "shared"]);
	assert.equal(expanded[2]?.linkedFrom?.assetId, "first");
});

test("expandSearchCandidates keeps at most 8 neighbors per seed", () => {
	const first = asset("first", "first.md", "text");
	const extras = Array.from({ length: SEARCH_NEIGHBORS_PER_SEED + 1 }, (_, index) => (
		asset(`n${String(index).padStart(2, "0")}`, `n${String(index).padStart(2, "0")}.jpg`)
	));
	const assetsById = new Map([first, ...extras].map((item) => [item.assetId, item]));
	const expanded = expandSearchCandidates(
		[seed(first)],
		extras.map((item) => relation("first", item.assetId, "ref")),
		assetsById,
		new Map(),
		new Map(),
	);
	const ids = expanded.map((item) => item.assetId);
	assert.equal(ids.includes("n08"), false);
	assert.deepEqual(ids.filter((id) => id.startsWith("n")), ["n00", "n01", "n02", "n03", "n04", "n05", "n06", "n07"]);
});

test("search walks relations before rerank and the limit can drop them", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-graph-search-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "clip.mp4"), "video");
		await writeFile(join(root, "frame.jpg"), "frame");
		await writeFile(join(root, "still.jpg"), "still");
		const snapshot = await core.openLibrary(root);
		const clip = snapshot.assets.find((item) => item.relativePath === "clip.mp4");
		const frame = snapshot.assets.find((item) => item.relativePath === "frame.jpg");
		const still = snapshot.assets.find((item) => item.relativePath === "still.jpg");
		assert.ok(clip && frame && still);
		await core.createRelation(frame.assetId, clip.assetId, "derived");
		await core.createRelation(clip.assetId, still.assetId, "reference");

		const listed = await core.searchAssets({ query: "clip" });
		assert.deepEqual(listed.assets.map((item) => item.relativePath), ["clip.mp4", "frame.jpg", "still.jpg"]);
		assert.equal(listed.assets[0]?.linkedFrom, undefined);
		assert.equal(listed.assets[1]?.linkedFrom?.relationType, "derived");
		assert.equal(listed.assets[1]?.linkedFrom?.direction, "in");
		assert.equal(listed.assets[1]?.linkedFrom?.assetId, clip.assetId);
		assert.equal(listed.assets[2]?.linkedFrom?.direction, "out");
		assert.equal(JSON.stringify(listed).includes(root), false);

		const videos = await core.searchAssets({ query: "clip", type: "video" });
		assert.deepEqual(videos.assets.map((item) => item.relativePath), ["clip.mp4", "frame.jpg", "still.jpg"]);

		const status = await core.createProperty("Status", "text");
		await core.setAssetProperty(clip.assetId, status.propertyId, "Hold");
		const held = await core.searchAssets({
			query: "clip",
			properties: [{ name: "Status", operator: "eq", value: "Hold" }],
		});
		assert.deepEqual(held.assets.map((item) => item.relativePath), ["clip.mp4", "frame.jpg", "still.jpg"]);

		const page = await core.searchAssets({ query: "clip", limit: 1 });
		assert.deepEqual(page.assets.map((item) => item.assetId), [clip.assetId]);
		assert.equal(page.total, 3);

		const unqueried = await core.searchAssets({ type: "video" });
		assert.deepEqual(unqueried.assets.map((item) => item.relativePath), ["clip.mp4"]);

		const documents: string[] = [];
		const reranked = await core.searchAssets({ query: "clip" }, undefined, {
			modelId: "eval-rerank",
			rerank: async (_query, docs) => {
				documents.push(...docs);
				return docs.map((text) => (text.includes("frame") ? 1 : 0));
			},
		});
		assert.equal(reranked.assets[0]?.relativePath, "frame.jpg");
		assert.equal(reranked.assets[0]?.linkedFrom?.relationType, "derived");
		assert.deepEqual(documents, ["clip.mp4", "frame.jpg", "still.jpg"]);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("a file that already matched is not added again as a neighbor", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-graph-dedupe-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "dock-clip.mp4"), "video");
		await writeFile(join(root, "dock-frame.jpg"), "frame");
		const snapshot = await core.openLibrary(root);
		const clip = snapshot.assets.find((item) => item.relativePath === "dock-clip.mp4");
		const frame = snapshot.assets.find((item) => item.relativePath === "dock-frame.jpg");
		assert.ok(clip && frame);
		await core.createRelation(frame.assetId, clip.assetId, "derived");
		const result = await core.searchAssets({ query: "dock" });
		assert.equal(result.total, 2);
		assert.equal(result.assets.every((item) => item.linkedFrom === undefined), true);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
