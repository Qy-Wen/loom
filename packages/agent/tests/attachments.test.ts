import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	foldUserMessageForLlm,
	foldUserText,
	latestUiSelectionAssetId,
	promptAttachments,
	uiSelectionToAttach,
} from "../src/attachments.ts";
import { assetRefMarker, composerLayoutText, parseComposerAssetInputs, storedAssetRefs } from "../src/composer-asset.ts";
import { bytesToBase64, parseComposerImageInputs, sniffComposerImage } from "../src/composer-image.ts";

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

describe("promptAttachments", () => {
	it("keeps an explicit chip and skips the same implicit selection", () => {
		assert.deepEqual(promptAttachments([clip], clip, []), [clip]);
	});

	it("appends a different implicit selection after the chips", () => {
		const selected = { ...clip, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(promptAttachments([clip], selected, []), [clip, selected]);
	});

	it("still omits an implicit selection already in the transcript", () => {
		const selected = { ...clip, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(promptAttachments([], selected, [{ attachments: [selected] }]), []);
	});
});

describe("composer asset chips", () => {
	it("accepts a library-relative chip and ignores a duplicate id", () => {
		assert.deepEqual(parseComposerAssetInputs([clip, { ...clip }]), [clip]);
	});

	it("rejects an absolute path", () => {
		assert.throws(() => parseComposerAssetInputs([{ ...clip, path: "/tmp/hero.mp4" }]));
		assert.throws(() => parseComposerAssetInputs([{ ...clip, path: "C:\\clips\\hero.mp4" }]));
		assert.deepEqual(storedAssetRefs([{ ...clip, path: "/tmp/hero.mp4" }]), []);
	});

	it("layout text is one space per chip, without the hidden id", () => {
		assert.equal(composerLayoutText(`hello${assetRefMarker(clip.assetId)}world`), "hello world");
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

	it("folds a chip where it sits in the text", () => {
		const text = `看一下${assetRefMarker(clip.assetId)}这段`;
		assert.equal(foldUserText(text, [clip]), `看一下\n\n${foldUserText("", [clip])}\n\n这段`);
	});

	it("appends a selection that was not placed in the text", () => {
		const other = { ...clip, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		const text = `看一下${assetRefMarker(clip.assetId)}这段`;
		const folded = foldUserText(text, [clip, other]);
		assert.match(folded, /^看一下\n\n<ui_selection>\npath: clips\/hero\.mp4/);
		assert.match(folded, /这段\n\n<ui_selection>\npath: notes\/brief\.md\nasset_id: asset-2\ntype: text\n<\/ui_selection>$/);
	});

	it("leaves a composer image on content", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const image = { type: "image" as const, data: bytesToBase64(png), mimeType: "image/png" };
		const message = { role: "user", content: [{ type: "text", text: "look" }, image] };
		assert.equal(foldUserMessageForLlm(message), message);
	});

	it("rejects a file that is not a JPEG, PNG, GIF, or WebP", () => {
		assert.equal(sniffComposerImage(new Uint8Array([0, 1, 2, 3])), undefined);
		assert.throws(() => parseComposerImageInputs([{ filename: "x.txt", mimeType: "image/png", data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) }]));
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
