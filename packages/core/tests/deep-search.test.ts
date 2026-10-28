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

/** Extracts are made in the background; simple search reads file text from them. */
async function waitForExtracts(core: LocalCore, assetIds: string[]): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < 5_000) {
		const records = await Promise.all(assetIds.map((id) => core.getAssetEnrichment(id)));
		if (records.every((record) => record?.status === "ready")) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Extracts did not finish");
}

async function openEvalLibrary(): Promise<{ root: string; core: LocalCore; riverId: string; soupId: string }> {
	const root = await mkdtemp(join(tmpdir(), "loom-deep-"));
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

async function withLibrary(run: (library: Awaited<ReturnType<typeof openEvalLibrary>>) => Promise<void>): Promise<void> {
	const library = await openEvalLibrary();
	try {
		await run(library);
	} finally {
		await library.core.close();
		await rm(library.root, { recursive: true, force: true });
	}
}

test("deep search: full text alone returns the matching passage", () => withLibrary(async ({ core, soupId }) => {
	const result = await core.deepSearchAssets({ query: "tomato soup" });
	assert.equal(result.total, 1);
	assert.equal(result.assets[0]?.assetId, soupId);
	assert.match(result.assets[0]?.passage ?? "", /Tomato soup/);
	assert.ok(result.assets[0]?.chunkId);
	assert.ok((result.assets[0]?.score ?? 0) > 0);
}));

test("deep search: a vector-only match returns the child passage and its parent", () => withLibrary(async ({ core, riverId }) => {
	const result = await core.deepSearchAssets({ query: "two-wheeled vehicle" }, evalEmbed());
	assert.ok(result.total >= 1);
	assert.equal(result.assets[0]?.assetId, riverId);
	assert.match(result.assets[0]?.passage ?? "", /bicycle/);
	assert.match(result.assets[0]?.parentPassage ?? "", /bicycle/);
}));

test("deep search: RRF fuses full text and vectors; property filters stay AND", () => withLibrary(async ({ core, riverId, soupId }) => {
	const fused = await core.deepSearchAssets({ query: "basil" }, {
		modelId: "eval-embed",
		embed: async () => [[1, 0]],
	});
	const ids = fused.assets.map((asset) => asset.assetId);
	assert.equal(fused.total, 2);
	assert.ok(ids.includes(riverId));
	assert.ok(ids.includes(soupId));

	const status = await core.createProperty("Status", "text");
	await core.setAssetProperty(riverId, status.propertyId, "Hold");
	await core.setAssetProperty(soupId, status.propertyId, "Published");
	const filtered = await core.deepSearchAssets({
		query: "two-wheeled vehicle",
		properties: [{ name: "Status", operator: "eq", value: "Hold" }],
	}, evalEmbed());
	assert.equal(filtered.total, 1);
	assert.equal(filtered.assets[0]?.assetId, riverId);

	const soupOnly = await core.deepSearchAssets({
		query: "recipe",
		properties: [{ name: "Status", operator: "eq", value: "Published" }],
	}, evalEmbed());
	assert.equal(soupOnly.total, 1);
	assert.equal(soupOnly.assets[0]?.assetId, soupId);
}));

test("deep search: an embedding failure falls back to full text", () => withLibrary(async ({ core, riverId }) => {
	const result = await core.deepSearchAssets({ query: "bicycle" }, {
		modelId: "broken",
		embed: async () => {
			throw new Error("offline");
		},
	});
	assert.equal(result.total, 1);
	assert.equal(result.assets[0]?.assetId, riverId);
	assert.match(result.assets[0]?.passage ?? "", /bicycle/);
}));

test("deep search: rerank reorders the fused passages; failure keeps the fused order", () => withLibrary(async ({ core, riverId, soupId }) => {
	const embed = { modelId: "eval-embed", embed: async () => [[1, 0]] };
	const seen: string[][] = [];
	const reranked = await core.deepSearchAssets({ query: "basil" }, embed, {
		modelId: "eval-rerank",
		rerank: async (_query: string, documents: string[]) => {
			seen.push(documents);
			return documents.map((text) => (/tomato|soup|basil|recipe/i.test(text) ? 1 : 0));
		},
	});
	assert.equal(reranked.total, 2);
	assert.equal(reranked.assets[0]?.assetId, soupId);
	assert.ok(reranked.assets.some((asset) => asset.assetId === riverId));
	// The reranker sees passage text, never a bare filename, because every row is a chunk.
	assert.ok(seen[0]?.every((text) => /bicycle|tomato/i.test(text)));

	const fallback = await core.deepSearchAssets({ query: "basil" }, embed, {
		modelId: "broken-rerank",
		rerank: async () => {
			throw new Error("offline");
		},
	});
	assert.equal(fallback.total, 2);
	assert.deepEqual(fallback.assets.map((asset) => asset.assetId).sort(), [riverId, soupId].sort());
}));

test("deep search: reports how many files it can see, and finds nothing in an unindexed file", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-deep-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "indexed.md"), "Amber harvest plan.\n");
		await writeFile(join(root, "plain.md"), "Amber harvest notes.\n");
		const snapshot = await core.openLibrary(root);
		const indexed = snapshot.assets.find((asset) => asset.relativePath === "indexed.md");
		assert.ok(indexed);
		await waitForExtracts(core, snapshot.assets.map((asset) => asset.assetId));

		const before = await core.deepSearchAssets({ query: "amber" });
		assert.equal(before.indexedCount, 0);
		assert.equal(before.total, 0);

		await core.embedTextAsset(indexed.assetId, evalEmbed());
		const after = await core.deepSearchAssets({ query: "amber" });
		assert.equal(after.indexedCount, 1);
		assert.deepEqual(after.assets.map((asset) => asset.relativePath), ["indexed.md"]);
		// Simple search still sees both files.
		assert.equal((await core.searchAssets({ query: "amber" })).total, 2);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("deep search: gives each file only its best passage", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-deep-"));
	const core = new LocalCore();
	try {
		const long = Array.from({ length: 12 }, (_, index) => `Section ${index}: lantern festival notes and lantern photos.`).join("\n\n");
		await writeFile(join(root, "long.md"), long);
		const snapshot = await core.openLibrary(root);
		const asset = snapshot.assets[0];
		assert.ok(asset);
		await core.embedTextAsset(asset.assetId, evalEmbed());
		const result = await core.deepSearchAssets({ query: "lantern" });
		assert.equal(result.total, 1);
		assert.equal(result.assets[0]?.assetId, asset.assetId);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("deep search: finds Chinese by a word inside a sentence", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-deep-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "日记.md"), "今天天气很好，我们去公园散步，然后回家做饭。\n");
		const asset = (await core.openLibrary(root)).assets[0];
		assert.ok(asset);
		await core.embedTextAsset(asset.assetId, evalEmbed());
		const result = await core.deepSearchAssets({ query: "公园" });
		assert.equal(result.total, 1);
		assert.match(result.assets[0]?.passage ?? "", /公园/);
		assert.equal((await core.deepSearchAssets({ query: "手机" })).total, 0);
		assert.equal((await core.searchAssets({ query: "日记" })).total, 1);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("deep search: with no query text it lists files and still reports indexedCount", () => withLibrary(async ({ core }) => {
	const result = await core.deepSearchAssets({ query: "  ", type: "text" });
	assert.equal(result.total, 2);
	assert.equal(result.indexedCount, 2);
	assert.equal(result.assets[0]?.passage, undefined);
}));

test("simple search: full text only, no passages, and no model is used", () => withLibrary(async ({ core, soupId }) => {
	const result = await core.searchAssets({ query: "tomato soup" });
	assert.equal(result.total, 1);
	assert.equal(result.assets[0]?.assetId, soupId);
	assert.equal(result.assets[0]?.passage, undefined);
	// A purely semantic query finds nothing without vectors.
	assert.equal((await core.searchAssets({ query: "two-wheeled vehicle" })).total, 0);
}));
