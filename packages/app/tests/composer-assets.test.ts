import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composerAssetsAtSend } from "../src/main/composer/composer-assets.ts";

const chip = {
	type: "asset_ref" as const,
	assetId: "asset-1",
	path: "clips/hero.mp4",
	assetType: "video" as const,
};

describe("composerAssetsAtSend", () => {
	it("rewrites path and type from the live library", () => {
		assert.deepEqual(
			composerAssetsAtSend([chip], [{ assetId: "asset-1", relativePath: "archive/hero.mp4", type: "video" }]),
			[{ ...chip, path: "archive/hero.mp4" }],
		);
	});

	it("keeps the staged snapshot when the asset is gone", () => {
		assert.deepEqual(composerAssetsAtSend([chip], []), [chip]);
	});

	it("keeps the staged snapshot when the live path is not library-relative", () => {
		assert.deepEqual(
			composerAssetsAtSend([chip], [{ assetId: "asset-1", relativePath: "/tmp/hero.mp4", type: "video" }]),
			[chip],
		);
	});
});
