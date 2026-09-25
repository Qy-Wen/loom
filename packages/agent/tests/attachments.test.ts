import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	foldUserMessageForLlm,
	foldUserText,
	latestUiSelectionAssetId,
	uiSelectionToAttach,
} from "../src/attachments.ts";

const clip = {
	type: "ui_selection" as const,
	assetId: "asset-1",
	path: "clips/hero.mp4",
	assetType: "video" as const,
};

describe("uiSelectionToAttach", () => {
	it("omits an empty selection", () => {
		assert.equal(uiSelectionToAttach(null, []), undefined);
	});

	it("attaches the first selection in a thread", () => {
		assert.deepEqual(uiSelectionToAttach(clip, []), clip);
	});

	it("skips when the latest transcript selection is the same asset", () => {
		assert.equal(
			uiSelectionToAttach(clip, [{ attachments: [clip] }, { role: "assistant" }]),
			undefined,
		);
	});

	it("attaches again after the selection changes", () => {
		const next = { ...clip, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(uiSelectionToAttach(next, [{ attachments: [clip] }]), next);
	});
});

describe("latestUiSelectionAssetId", () => {
	it("walks back past user rows that skipped injection", () => {
		assert.equal(
			latestUiSelectionAssetId([
				{ attachments: [clip] },
				{ attachments: undefined },
			]),
			"asset-1",
		);
	});
});

describe("foldUserMessageForLlm", () => {
	it("leaves content alone when there are no attachments", () => {
		const message = { role: "user", content: [{ type: "text", text: "hello" }] };
		assert.equal(foldUserMessageForLlm(message), message);
	});

	it("folds selection into one string and keeps the stored row's attachments", () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "把这个处理一下" }],
			attachments: [clip],
		};
		assert.deepEqual(foldUserMessageForLlm(message), {
			...message,
			content: foldUserText("把这个处理一下", [clip]),
		});
		assert.match(String(foldUserMessageForLlm(message).content), /^把这个处理一下\n\n<ui_selection>\npath: clips\/hero\.mp4\nasset_id: asset-1\ntype: video\n<\/ui_selection>$/);
	});

	it("keeps image parts and uses a single text part for the fold", () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const folded = foldUserMessageForLlm({
			role: "user",
			content: [{ type: "text", text: "look" }, image],
			attachments: [clip],
		});
		assert.deepEqual(folded.content, [
			{ type: "text", text: foldUserText("look", [clip]) },
			image,
		]);
	});
});
