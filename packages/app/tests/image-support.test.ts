import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasImageAsset, modelLacksImageInput } from "../src/renderer/chat/image-support.ts";

const models = [
	{ provider: "deepseek", id: "text-only", input: ["text"] as ("text" | "image")[] },
	{ provider: "openai", id: "vision", input: ["text", "image"] as ("text" | "image")[] },
];

describe("image support notice", () => {
	it("flags a model whose input has no image", () => {
		assert.equal(modelLacksImageInput({ provider: "deepseek", modelId: "text-only" }, models), true);
	});

	it("does not flag a model that accepts images", () => {
		assert.equal(modelLacksImageInput({ provider: "openai", modelId: "vision" }, models), false);
	});

	it("matches provider and id together", () => {
		assert.equal(modelLacksImageInput({ provider: "openai", modelId: "text-only" }, models), false);
	});

	it("stays quiet while the catalog or the session model is unknown", () => {
		assert.equal(modelLacksImageInput(undefined, models), false);
		assert.equal(modelLacksImageInput({ provider: "deepseek", modelId: "text-only" }, null), false);
		assert.equal(modelLacksImageInput({ provider: "gone", modelId: "removed" }, models), false);
	});

	it("detects an attached image that is sent as an image block", () => {
		assert.equal(hasImageAsset([{ assetType: "video", path: "a.mp4" }, { assetType: "image", path: "clips/Hero.PNG" }]), true);
		assert.equal(hasImageAsset([{ assetType: "image", path: "a.webp" }]), true);
		assert.equal(hasImageAsset([]), false);
	});

	it("ignores video, audio, and image formats that stay library references", () => {
		assert.equal(hasImageAsset([{ assetType: "video", path: "a.mp4" }, { assetType: "audio", path: "a.mp3" }]), false);
		assert.equal(hasImageAsset([{ assetType: "image", path: "scan.bmp" }, { assetType: "image", path: "scan.tiff" }]), false);
		assert.equal(hasImageAsset([{ assetType: "image", path: "noextension" }]), false);
	});
});
