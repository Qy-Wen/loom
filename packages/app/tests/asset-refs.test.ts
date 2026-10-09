import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetRefsFromTool } from "../src/shared/asset-refs.ts";

const clip = { assetId: "asset-1", filename: "hero.mp4", relativePath: "clips/hero.mp4", type: "video" };

describe("assetRefsFromTool", () => {
	it("reads search results by asset id", () => {
		assert.deepEqual(
			assetRefsFromTool("search_assets", JSON.stringify({ total: 1, assets: [clip, { ...clip }] })),
			[{ assetId: "asset-1", path: "clips/hero.mp4", filename: "hero.mp4" }],
		);
	});

	it("reads the inspected asset and its relations", () => {
		assert.deepEqual(
			assetRefsFromTool("inspect_asset", {
				...clip,
				kind: "asset_detail",
				links: [{ asset: { assetId: "asset-2", filename: "still.png", relativePath: "stills/still.png", type: "image" } }],
			}),
			[
				{ assetId: "asset-1", path: "clips/hero.mp4", filename: "hero.mp4" },
				{ assetId: "asset-2", path: "stills/still.png", filename: "still.png" },
			],
		);
	});

	it("drops an absolute path and ignores other tools", () => {
		assert.deepEqual(
			assetRefsFromTool("search_assets", { assets: [{ assetId: "asset-1", filename: "hero.mp4", relativePath: "/tmp/hero.mp4" }] }),
			[],
		);
		assert.equal(assetRefsFromTool("describe_image", { assetId: "asset-1" }), null);
	});
});
