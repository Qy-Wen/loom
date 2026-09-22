import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import type { LoomToolResult } from "@loom/agent";
import { createAssetTools } from "../src/main/asset-tools.ts";

test("asset tools return structured safe results", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-asset-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "hero.jpg"), "image");
		const snapshot = await core.openLibrary(root);
		const hero = snapshot.assets[0];
		assert.ok(hero);

		const tools = createAssetTools(core);
		const search = tools.find((tool) => tool.name === "search_assets");
		const inspect = tools.find((tool) => tool.name === "inspect_asset");
		assert.ok(search && inspect);

		const searchResult = await search.execute({ query: "hero", type: "image" }) as LoomToolResult;
		assert.equal((searchResult.details as { kind: string }).kind, "asset_list");
		assert.equal(searchResult.content.includes(hero.assetId), true);
		assert.equal(JSON.stringify(searchResult).includes(root), false);

		const detailResult = await inspect.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((detailResult.details as { kind: string }).kind, "asset_detail");
		assert.equal(JSON.stringify(detailResult).includes(root), false);

		await assert.rejects(Promise.resolve().then(() => search.execute({ type: "invalid" })), /supported asset type/);
		await assert.rejects(Promise.resolve().then(() => inspect.execute({ assetId: "" })), /non-empty string/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
