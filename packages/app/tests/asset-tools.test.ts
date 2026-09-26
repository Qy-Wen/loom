import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import { toolResultText, type LoomToolResult } from "@loom/agent";
import { createAssetTools } from "../src/main/asset-tools.ts";

test("asset tools return structured safe results", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-asset-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "hero.jpg"), "image");
		const snapshot = await core.openLibrary(root);
		const hero = snapshot.assets[0];
		assert.ok(hero);

		const tools = createAssetTools(core, {
			embedAsset: (assetId) => core.embedTextAsset(assetId, {
				modelId: "test-embed",
				embed: async (texts) => texts.map(() => [0.1, 0.2]),
			}),
			describeImage: (assetId) => core.describeImageAsset(assetId, {
				modelId: "test-vlm",
				describe: async () => "## Caption\nA test image.\n\n## Tags\ntest",
			}),
		});
		const search = tools.find((tool) => tool.name === "search_assets");
		const inspect = tools.find((tool) => tool.name === "inspect_asset");
		const describe = tools.find((tool) => tool.name === "describe_image");
		assert.ok(search && inspect && describe);

		const searchResult = await search.execute({ query: "hero", type: "image" }) as LoomToolResult;
		assert.equal((searchResult.details as { kind: string }).kind, "asset_list");
		assert.equal(toolResultText(searchResult.content).includes(hero.assetId), true);
		assert.equal(JSON.stringify(searchResult).includes(root), false);

		const detailResult = await inspect.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((detailResult.details as { kind: string }).kind, "asset_detail");
		assert.equal(JSON.stringify(detailResult).includes(root), false);

		const described = await describe.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((described.details as { status: string }).status, "ready");
		const after = await inspect.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((after.details as { imageVlm: { status: string } }).imageVlm.status, "ready");
		assert.equal((await core.searchAssets({ query: "test image" })).total, 1);

		await assert.rejects(Promise.resolve().then(() => search.execute({ type: "invalid" })), /supported asset type/);
		await assert.rejects(Promise.resolve().then(() => inspect.execute({ assetId: "" })), /non-empty string/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
