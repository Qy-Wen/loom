import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { LocalCore } from "@loom/core";
import type { LoomToolResult } from "@loom/agent";
import { createAssetTools } from "../src/main/tools/asset-tools.ts";

test("asset tools return structured safe results", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-asset-tools-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "hero.jpg"), "image");
		await writeFile(join(root, "clip.mp4"), "video");
		await writeFile(join(root, "rain.mp3"), "audio");
		const snapshot = await core.openLibrary(root);
		const hero = snapshot.assets.find((asset) => asset.filename === "hero.jpg");
		const clip = snapshot.assets.find((asset) => asset.filename === "clip.mp4");
		const rain = snapshot.assets.find((asset) => asset.filename === "rain.mp3");
		assert.ok(hero);
		assert.ok(clip);
		assert.ok(rain);

		const tools = createAssetTools(core, {
			embedAsset: (assetId) => core.embedTextAsset(assetId, {
				modelId: "test-embed",
				embed: async (texts) => texts.map(() => [0.1, 0.2]),
			}),
			describeImage: (assetId) => core.describeImageAsset(assetId, {
				modelId: "test-vlm",
				describe: async () => "## Caption\nA test image.\n\n## Tags\ntest",
			}),
			describeVideo: (assetId) => core.describeVideoAsset(assetId, {
				modelId: "test-vlm",
				describe: async () => "## Caption\nA test clip.\n\n## Tags\nvideo",
			}),
			describeAudio: (assetId) => core.describeAudioAsset(assetId, {
				modelId: "qwen2-audio-7b-instruct",
				describe: async () => "## Caption\nRain on a roof.\n\n## Tags\nrain\n\n## Transcript\nNone",
			}),
		});
		const search = tools.find((tool) => tool.name === "search_assets");
		const inspect = tools.find((tool) => tool.name === "inspect_asset");
		const describe = tools.find((tool) => tool.name === "describe_image");
		const describeVideo = tools.find((tool) => tool.name === "describe_video");
		const describeAudio = tools.find((tool) => tool.name === "describe_audio");
		assert.ok(search && inspect && describe && describeVideo && describeAudio);

		const searchResult = await search.execute({ query: "hero", type: "image" }) as LoomToolResult;
		assert.equal((searchResult.details as { kind: string }).kind, "asset_list");
		assert.equal(typeof searchResult.content, "string");
		assert.ok((searchResult.content as string).includes(hero.assetId));
		assert.equal(JSON.stringify(searchResult).includes(root), false);

		const detailResult = await inspect.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((detailResult.details as { kind: string }).kind, "asset_detail");
		assert.equal(JSON.stringify(detailResult).includes(root), false);

		const described = await describe.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((described.details as { status: string }).status, "ready");
		const after = await inspect.execute({ assetId: hero.assetId }) as LoomToolResult;
		assert.equal((after.details as { imageVlm: { status: string } }).imageVlm.status, "ready");
		assert.equal((await core.searchAssets({ query: "test image" })).total, 1);

		const describedVideo = await describeVideo.execute({ assetId: clip.assetId }) as LoomToolResult;
		assert.equal((describedVideo.details as { status: string }).status, "ready");
		const afterVideo = await inspect.execute({ assetId: clip.assetId }) as LoomToolResult;
		assert.equal((afterVideo.details as { videoVlm: { status: string } }).videoVlm.status, "ready");
		assert.equal((await core.searchAssets({ query: "test clip" })).total, 1);

		const describedAudio = await describeAudio.execute({ assetId: rain.assetId }) as LoomToolResult;
		assert.equal((describedAudio.details as { status: string }).status, "ready");
		const afterAudio = await inspect.execute({ assetId: rain.assetId }) as LoomToolResult;
		assert.equal((afterAudio.details as { audioWriteup: { status: string } }).audioWriteup.status, "ready");
		assert.equal((await core.searchAssets({ query: "Rain on a roof" })).total, 1);

		const deep = tools.find((tool) => tool.name === "deep_search_assets");
		assert.ok(deep);
		await assert.rejects(Promise.resolve().then(() => deep.execute({ type: "image" })), /non-empty query/);
		await assert.rejects(Promise.resolve().then(() => deep.execute({ query: "   " })), /non-empty query/);
		const deepEmpty = await deep.execute({ query: "test image" }) as LoomToolResult;
		const deepBody = JSON.parse(deepEmpty.content as string) as { total: number; indexedCount: number };
		assert.equal(deepBody.total, 0);
		assert.equal(deepBody.indexedCount, 0);
		assert.equal(JSON.stringify(deepEmpty).includes(root), false);

		const embedded = await core.embedTextAsset(hero.assetId, { modelId: "test-embed", embed: async (texts) => texts.map(() => [0.1, 0.2]) });
		assert.equal(embedded.status, "ready");
		const deepHit = await deep.execute({ query: "test image", type: "image" }) as LoomToolResult;
		const hitBody = JSON.parse(deepHit.content as string) as { total: number; indexedCount: number; assets: Array<{ assetId: string; passage?: string }> };
		assert.equal(hitBody.indexedCount, 1);
		assert.equal(hitBody.total, 1);
		assert.equal(hitBody.assets[0]?.assetId, hero.assetId);
		assert.match(hitBody.assets[0]?.passage ?? "", /test image/i);
		assert.equal(JSON.stringify(deepHit).includes(root), false);

		await assert.rejects(Promise.resolve().then(() => search.execute({ type: "invalid" })), /supported asset type/);
		await assert.rejects(Promise.resolve().then(() => inspect.execute({ assetId: "" })), /non-empty string/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("embed_asset skips a current index unless force is set", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-embed-force-"));
	const core = new LocalCore();
	try {
		await writeFile(join(root, "note.md"), "# Note\n\nHello world.\n");
		const snapshot = await core.openLibrary(root);
		const note = snapshot.assets[0]!;
		let requests = 0;
		const tools = createAssetTools(core, {
			embedAsset: (assetId, signal, options) => core.embedTextAsset(assetId, {
				modelId: "test-embed",
				embed: async (texts) => { requests += 1; return texts.map(() => [0.1, 0.2]); },
			}, signal, options),
			describeImage: async () => { throw new Error("unused"); },
			describeVideo: async () => { throw new Error("unused"); },
			describeAudio: async () => { throw new Error("unused"); },
		});
		const embed = tools.find((tool) => tool.name === "embed_asset")!;
		await embed.execute({ assetId: note.assetId });
		await embed.execute({ assetId: note.assetId });
		assert.equal(requests, 1);
		await embed.execute({ assetId: note.assetId, force: false });
		assert.equal(requests, 1);
		const forced = await embed.execute({ assetId: note.assetId, force: true }) as LoomToolResult;
		assert.equal(requests, 2);
		assert.equal((forced.details as { status: string }).status, "ready");
		await assert.rejects(Promise.resolve().then(() => embed.execute({ assetId: note.assetId, force: "yes" })), /boolean/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
