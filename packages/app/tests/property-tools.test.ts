import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import type { LoomToolResult } from "@loom/agent";
import { createPropertyTools } from "../src/main/property-tools.ts";

test("property tools add a column, write a cell, and delete the column", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-property-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "clip.mp4"), "video");
		const snapshot = await core.openLibrary(root);
		const clip = snapshot.assets.find((asset) => asset.relativePath === "clip.mp4");
		assert.ok(clip);

		const tools = createPropertyTools(core);
		const list = tools.find((tool) => tool.name === "list_properties");
		const create = tools.find((tool) => tool.name === "create_property");
		const update = tools.find((tool) => tool.name === "update_property");
		const remove = tools.find((tool) => tool.name === "remove_property");
		const set = tools.find((tool) => tool.name === "set_asset_property");
		const clear = tools.find((tool) => tool.name === "clear_asset_property");
		assert.ok(list && create && update && remove && set && clear);

		await assert.rejects(Promise.resolve().then(() => create.execute({ name: "  ", type: "text" })), /name/);

		const created = await create.execute({ name: "  Status  ", type: "text" }) as LoomToolResult;
		const column = created.details as { propertyId: string; name: string; type: string };
		assert.equal(column.name, "Status");
		assert.equal(column.type, "text");
		assert.equal(JSON.stringify(created).includes(root), false);

		const listed = await list.execute({}) as LoomToolResult;
		assert.deepEqual(listed.details, [{ propertyId: column.propertyId, name: "Status", type: "text" }]);

		await set.execute({ assetId: clip.assetId, propertyId: column.propertyId, value: "Published" });
		const detail = await core.inspectAsset(clip.assetId);
		assert.equal(detail.properties[0]?.name, "Status");
		assert.equal(detail.properties[0]?.value, "Published");

		await assert.rejects(
			Promise.resolve().then(() => update.execute({ propertyId: column.propertyId, name: "Status", type: "number" })),
			/type/,
		);
		await clear.execute({ assetId: clip.assetId, propertyId: column.propertyId });
		assert.deepEqual((await core.inspectAsset(clip.assetId)).properties, []);

		const renamed = await update.execute({ propertyId: column.propertyId, name: "Stage", type: "text" }) as LoomToolResult;
		assert.deepEqual(renamed.details, { propertyId: column.propertyId, name: "Stage", type: "text" });

		await remove.execute({ propertyId: column.propertyId });
		const empty = await list.execute({}) as LoomToolResult;
		assert.deepEqual(empty.details, []);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
