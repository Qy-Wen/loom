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
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
