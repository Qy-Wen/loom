import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import type { LoomToolResult } from "@loom/agent";
import { createRelationTools } from "../src/main/relation-tools.ts";

test("create_relation and remove_relation write and delete one edge", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-relation-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "source.mp4"), "video");
		await writeFile(join(root, "frame.jpg"), "frame");
		const snapshot = await core.openLibrary(root);
		const source = snapshot.assets.find((asset) => asset.relativePath === "source.mp4");
		const frame = snapshot.assets.find((asset) => asset.relativePath === "frame.jpg");
		assert.ok(source && frame);

		const tools = createRelationTools(core);
		const create = tools.find((tool) => tool.name === "create_relation");
		const remove = tools.find((tool) => tool.name === "remove_relation");
		assert.ok(create && remove);

		await assert.rejects(Promise.resolve().then(() => create.execute({ fromAssetId: "", toAssetId: frame.assetId, type: "derived from" })), /fromAssetId/);

		const created = await create.execute({
			fromAssetId: frame.assetId,
			toAssetId: source.assetId,
			type: "  derived from  ",
		}) as LoomToolResult;
		const relation = created.details as { relationId: string; type: string; fromAssetId: string; toAssetId: string };
		assert.equal(relation.type, "derived from");
		assert.equal(relation.fromAssetId, frame.assetId);
		assert.equal(relation.toAssetId, source.assetId);
		assert.equal(JSON.stringify(created).includes(root), false);

		const detail = await core.inspectAsset(frame.assetId);
		assert.equal(detail.links[0]?.relationId, relation.relationId);
		assert.equal(detail.links[0]?.direction, "out");

		await remove.execute({ relationId: relation.relationId });
		assert.deepEqual((await core.inspectAsset(frame.assetId)).links, []);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
