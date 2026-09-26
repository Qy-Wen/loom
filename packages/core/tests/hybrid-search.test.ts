import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalCore } from "../src/index.ts";
import type { EmbeddingProvider } from "../src/model/text-embed.ts";

const RIVER = "A red bicycle leans against the dock by the river.\n";
const SOUP = "Tomato soup recipe with basil.\n";

function evalEmbed(): EmbeddingProvider {
	return {
		modelId: "eval-embed",
		async embed(texts: string[]) {
			return texts.map((text) => {
				const lower = text.toLowerCase();
				if (/bicycle|dock|river|two|wheeled|vehicle/.test(lower)) return [1, 0];
				if (/tomato|soup|basil|recipe/.test(lower)) return [0, 1];
				return [0.5, 0.5];
			});
		},
	};
}

async function openEvalLibrary(): Promise<{ root: string; core: LocalCore; riverId: string; soupId: string }> {
	const root = await mkdtemp(join(tmpdir(), "loom-hybrid-"));
	const core = new LocalCore();
	await writeFile(join(root, "river.md"), RIVER);
	await writeFile(join(root, "soup.md"), SOUP);
	const snapshot = await core.openLibrary(root);
	const river = snapshot.assets.find((asset) => asset.relativePath === "river.md");
	const soup = snapshot.assets.find((asset) => asset.relativePath === "soup.md");
	assert.ok(river && soup);
	const provider = evalEmbed();
	assert.equal((await core.embedTextAsset(river.assetId, provider)).status, "ready");
	assert.equal((await core.embedTextAsset(soup.assetId, provider)).status, "ready");
	return { root, core, riverId: river.assetId, soupId: soup.assetId };
}

test("hybrid search: FTS-only still ranks without embeddings", async () => {
	const { root, core, soupId } = await openEvalLibrary();
	try {
		const result = await core.searchAssets({ query: "tomato soup" });
		assert.equal(result.total, 1);
		assert.equal(result.assets[0]?.assetId, soupId);
		assert.equal(result.assets[0]?.passage, undefined);
		assert.ok((result.assets[0]?.score ?? 0) > 0);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("hybrid search: vector-only query returns child passage and parent", async () => {
	const { root, core, riverId } = await openEvalLibrary();
	try {
		const result = await core.searchAssets({ query: "two-wheeled vehicle" }, evalEmbed());
		assert.ok(result.total >= 1);
		assert.equal(result.assets[0]?.assetId, riverId);
		assert.match(result.assets[0]?.passage ?? "", /bicycle/);
		assert.match(result.assets[0]?.parentPassage ?? "", /bicycle/);
		assert.ok(result.assets[0]?.chunkId);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("hybrid search: RRF fuses FTS and vec; property filters stay AND", async () => {
	const { root, core, riverId, soupId } = await openEvalLibrary();
	try {
		const fused = await core.searchAssets({ query: "basil" }, {
			modelId: "eval-embed",
			embed: async () => [[1, 0]],
		});
		const ids = fused.assets.map((asset) => asset.assetId);
		assert.equal(fused.total, 2);
		assert.ok(ids.includes(riverId));
		assert.ok(ids.includes(soupId));
		const riverHit = fused.assets.find((asset) => asset.assetId === riverId);
		assert.match(riverHit?.passage ?? "", /bicycle/);

		const status = await core.createProperty("Status", "text");
		await core.setAssetProperty(riverId, status.propertyId, "Hold");
		await core.setAssetProperty(soupId, status.propertyId, "Published");
		const filtered = await core.searchAssets({
			query: "two-wheeled vehicle",
			properties: [{ name: "Status", operator: "eq", value: "Hold" }],
		}, evalEmbed());
		assert.equal(filtered.total, 1);
		assert.equal(filtered.assets[0]?.assetId, riverId);

		const soupOnly = await core.searchAssets({
			query: "recipe",
			properties: [{ name: "Status", operator: "eq", value: "Published" }],
		}, evalEmbed());
		assert.equal(soupOnly.total, 1);
		assert.equal(soupOnly.assets[0]?.assetId, soupId);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("hybrid search: embed failure falls back to FTS", async () => {
	const { root, core, riverId } = await openEvalLibrary();
	try {
		const result = await core.searchAssets({ query: "bicycle" }, {
			modelId: "broken",
			embed: async () => {
				throw new Error("offline");
			},
		});
		assert.equal(result.total, 1);
		assert.equal(result.assets[0]?.assetId, riverId);
		assert.equal(result.assets[0]?.passage, undefined);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
