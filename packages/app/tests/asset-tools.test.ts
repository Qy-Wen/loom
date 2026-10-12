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

		await assert.rejects(Promise.resolve().then(() => search.execute({ type: "invalid" })), /supported asset type/);
		await assert.rejects(Promise.resolve().then(() => inspect.execute({ assetId: "" })), /non-empty string/);
	} finally {
		await core.close();
		await rm(root, { recursive: true, force: true });
	}
});
