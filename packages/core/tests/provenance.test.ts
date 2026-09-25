import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "../src/index.ts";
import { GENERATED_FROM } from "../src/stores/types.ts";

test("inspect_asset exposes persisted GENERATED_FROM edges", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-provenance-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "clip.mp4"), "video");
		await mkdir(join(root, "outputs"));
		await writeFile(join(root, "outputs", "frame.jpg"), "frame");
		const snapshot = await core.openLibrary(root);
		const source = snapshot.assets.find((asset) => asset.relativePath === "clip.mp4");
		const output = snapshot.assets.find((asset) => asset.relativePath === "outputs/frame.jpg");
		assert.ok(source);
		assert.ok(output);

		await core.graphStore.upsertRelation({
			relationId: `${output.assetId}:${source.assetId}:${GENERATED_FROM}`,
			fromAssetId: output.assetId,
			toAssetId: source.assetId,
			type: GENERATED_FROM,
		});

		const sourceDetail = await core.inspectAsset(source.assetId);
		assert.deepEqual(
			sourceDetail.generated.map((item) => item.relativePath),
			["outputs/frame.jpg"],
		);
		assert.deepEqual(sourceDetail.generatedFrom, []);
		assert.equal(JSON.stringify(sourceDetail).includes(root), false);

		const outputDetail = await core.inspectAsset(output.assetId);
		assert.equal(outputDetail.generatedFrom[0]?.assetId, source.assetId);
		assert.equal(outputDetail.generatedFrom[0]?.filename, "clip.mp4");
		assert.deepEqual(outputDetail.generated, []);
		assert.equal(outputDetail.links[0]?.relationType, GENERATED_FROM);
		assert.equal(outputDetail.links[0]?.direction, "out");
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("createRelation stores custom types and rejects reserved labels", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-manual-rel-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "a.jpg"), "a");
		await writeFile(join(root, "b.jpg"), "b");
		const snapshot = await core.openLibrary(root);
		const first = snapshot.assets.find((asset) => asset.relativePath === "a.jpg");
		const second = snapshot.assets.find((asset) => asset.relativePath === "b.jpg");
		assert.ok(first);
		assert.ok(second);

		const created = await core.createRelation(first.assetId, second.assetId, "  similar to  ");
		assert.equal(created.type, "similar to");
		assert.equal(created.fromAssetId, first.assetId);
		assert.equal(created.toAssetId, second.assetId);

		const fromDetail = await core.inspectAsset(first.assetId);
		assert.equal(fromDetail.links.length, 1);
		assert.equal(fromDetail.links[0]?.relationType, "similar to");
		assert.equal(fromDetail.links[0]?.direction, "out");
		assert.equal(fromDetail.links[0]?.asset.assetId, second.assetId);
		assert.deepEqual(fromDetail.generatedFrom, []);
		assert.deepEqual(fromDetail.generated, []);

		const toDetail = await core.inspectAsset(second.assetId);
		assert.equal(toDetail.links[0]?.direction, "in");
		assert.equal(toDetail.links[0]?.asset.assetId, first.assetId);

		await assert.rejects(core.createRelation(first.assetId, second.assetId, "GENERATED_FROM"), /reserved/);
		await assert.rejects(core.createRelation(first.assetId, second.assetId, "related"), /reserved/);
		await assert.rejects(core.createRelation(first.assetId, first.assetId, "similar to"), /itself/);

		const again = await core.createRelation(first.assetId, second.assetId, "similar to");
		assert.equal((await core.listGraphRelations()).length, 1);
		assert.equal(again.relationId, created.relationId);

		await core.removeRelation(created.relationId);
		assert.deepEqual((await core.inspectAsset(first.assetId)).links, []);
		assert.deepEqual(await core.listGraphRelations(), []);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
