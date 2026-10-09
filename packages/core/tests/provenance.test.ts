import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "../src/index.ts";

test("inspect_asset exposes a relation as a link on both ends", async () => {
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

		await core.createRelation(output.assetId, source.assetId, "derived");

		const sourceDetail = await core.inspectAsset(source.assetId);
		assert.equal(sourceDetail.links[0]?.relationType, "derived");
		assert.equal(sourceDetail.links[0]?.direction, "in");
		assert.equal(sourceDetail.links[0]?.asset.relativePath, "outputs/frame.jpg");
		assert.equal(JSON.stringify(sourceDetail).includes(root), false);

		const outputDetail = await core.inspectAsset(output.assetId);
		assert.equal(outputDetail.links[0]?.asset.assetId, source.assetId);
		assert.equal(outputDetail.links[0]?.asset.filename, "clip.mp4");
		assert.equal(outputDetail.links[0]?.relationType, "derived");
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

		const toDetail = await core.inspectAsset(second.assetId);
		assert.equal(toDetail.links[0]?.direction, "in");
		assert.equal(toDetail.links[0]?.asset.assetId, first.assetId);

		const provenance = await core.createRelation(first.assetId, second.assetId, "GENERATED_FROM");
		assert.equal(provenance.type, "GENERATED_FROM");
		await core.removeRelation(provenance.relationId);
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
