import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { ENRICHMENT_VERSION, LocalCore } from "../src/index.ts";
import { compileFtsQuery, searchableEnrichmentTexts } from "../src/retrieval/text.ts";

test("LocalCore searches and inspects assets without exposing absolute paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-retrieval-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "sunset-final.jpg"), "image");
		await writeFile(join(root, "notes.txt"), "notes");
		const snapshot = await core.openLibrary(root);
		const image = snapshot.assets.find((asset) => asset.relativePath === "sunset-final.jpg");
		assert.ok(image);

		const rating = await core.createProperty("Rating", "number");
		const status = await core.createProperty("Status", "text");
		await core.setAssetProperty(image.assetId, rating.propertyId, 4.5);
		await core.setAssetProperty(image.assetId, status.propertyId, "Published");

		const result = await core.searchAssets({
			query: "sunset",
			type: "image",
			properties: [
				{ name: "rating", operator: "gte", value: 4 },
				{ name: "STATUS", operator: "contains", value: "publish" },
			],
		});
		assert.equal(result.kind, "asset_list");
		assert.equal(result.total, 1);
		assert.equal(result.assets[0]?.assetId, image.assetId);
		assert.equal(JSON.stringify(result).includes(root), false);

		const detail = await core.inspectAsset(image.assetId);
		assert.equal(detail.kind, "asset_detail");
		assert.equal(detail.previewRef.startsWith(`loom-asset://asset/${image.assetId}`), true);
		assert.deepEqual(
			Object.fromEntries(detail.properties.map((property) => [property.name, property.value])),
			{ Rating: 4.5, Status: "Published" },
		);
		assert.deepEqual(detail.generatedFrom, []);
		assert.deepEqual(detail.generated, []);
		assert.deepEqual(detail.links, []);
		assert.equal(JSON.stringify(detail).includes(root), false);

		assert.equal((await core.searchAssets({ query: "published", type: "image" })).total, 1);
		assert.equal((await core.searchAssets({ properties: [{ name: "Missing", operator: "eq", value: true }] })).total, 0);
		await assert.rejects(core.inspectAsset("missing"), /Asset not found/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("search_assets matches Level 1 text and camera extracts", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-search-enrich-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "brief.md"), "Launch the amber harvest campaign next week.");
		await writeFile(join(root, "other.txt"), "unrelated");
		await writeFile(join(root, "shot.jpg"), "image");
		const snapshot = await core.openLibrary(root);
		const brief = snapshot.assets.find((asset) => asset.relativePath === "brief.md");
		const shot = snapshot.assets.find((asset) => asset.relativePath === "shot.jpg");
		assert.ok(brief && shot);
		await core.analyzeAsset(brief.assetId);
		await core.metadataStore.upsertAssetEnrichment({
			assetId: shot.assetId,
			version: ENRICHMENT_VERSION,
			sourceModifiedAt: shot.modifiedAt,
			status: "ready",
			data: { kind: "image", width: 1920, height: 1080, camera: "Canon EOS R5" },
		});

		const byText = await core.searchAssets({ query: "amber harvest" });
		assert.equal(byText.total, 1);
		assert.equal(byText.assets[0]?.assetId, brief.assetId);
		assert.equal(JSON.stringify(byText).includes(root), false);

		const byCamera = await core.searchAssets({ query: "canon eos" });
		assert.equal(byCamera.total, 1);
		assert.equal(byCamera.assets[0]?.assetId, shot.assetId);
		assert.equal((await core.searchAssets({ query: "1920" })).total, 0);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("compileFtsQuery ANDs prefix tokens", () => {
	assert.equal(compileFtsQuery("  Canon EOS  "), `"canon"* AND "eos"*`);
	assert.equal(compileFtsQuery("***"), undefined);
});

test("searchableEnrichmentTexts uses ready extracts only", () => {
	assert.deepEqual(searchableEnrichmentTexts({
		assetId: "a",
		version: ENRICHMENT_VERSION,
		sourceModifiedAt: 1,
		status: "ready",
		data: { kind: "text", text: "hello", truncated: false, charCount: 5 },
	}), ["hello"]);
	assert.deepEqual(searchableEnrichmentTexts({
		assetId: "a",
		version: ENRICHMENT_VERSION,
		sourceModifiedAt: 1,
		status: "failed",
		error: "hello",
		data: { kind: "text", text: "hello", truncated: false, charCount: 5 },
	}), []);
	assert.deepEqual(searchableEnrichmentTexts({
		assetId: "a",
		version: ENRICHMENT_VERSION,
		sourceModifiedAt: 1,
		status: "ready",
		data: { kind: "video", duration: 12, videoCodec: "h264", audioCodec: "aac" },
	}), ["h264", "aac"]);
});
