import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	contentWithPlacedAssets,
	foldUserMessageForLlm,
	foldUserText,
	implicitSelectionAttachments,
	latestUiSelectionAssetId,
	promptAttachments,
	uiSelectionToAttach,
} from "../src/attachments.ts";
import { assetRefBlocks, composerLayoutText, displayAssetRefs, parseComposerAssetInputs, splitStoredAssetText, storedAssetRefs, stripInlineAssetRefs } from "../src/composer-asset.ts";
import { bytesToBase64, parseComposerImageInputs, sniffComposerImage } from "../src/composer-image.ts";

const fields = {
	assetId: "asset-1",
	path: "clips/hero.mp4",
	assetType: "video" as const,
};

const selection = {
	type: "ui_selection" as const,
	...fields,
};

const chip = {
	type: "asset_ref" as const,
	...fields,
};

describe("uiSelectionToAttach", () => {
	it("omits an empty selection", () => {
		assert.equal(uiSelectionToAttach(null, []), undefined);
	});

	it("attaches the first selection in a thread", () => {
		assert.deepEqual(uiSelectionToAttach(fields, []), selection);
	});

	it("skips when the latest transcript selection is the same asset", () => {
		assert.equal(
			uiSelectionToAttach(fields, [{ attachments: [selection] }, { role: "assistant" }]),
			undefined,
		);
	});

	it("attaches again after the selection changes", () => {
		const next = { assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(
			uiSelectionToAttach(next, [{ attachments: [selection] }]),
			{ type: "ui_selection", ...next },
		);
	});

	it("does not treat a composer chip as the last implicit selection", () => {
		assert.deepEqual(uiSelectionToAttach(fields, [{ attachments: [chip] }]), selection);
	});
});

describe("latestUiSelectionAssetId", () => {
	it("walks back past user rows that skipped injection", () => {
		assert.equal(
			latestUiSelectionAssetId([
				{ attachments: [selection] },
				{ attachments: undefined },
			]),
			"asset-1",
		);
	});

	it("ignores composer chips", () => {
		assert.equal(latestUiSelectionAssetId([{ attachments: [chip] }]), undefined);
	});
});

describe("promptAttachments", () => {
	it("keeps an explicit chip and skips the same implicit selection", () => {
		assert.deepEqual(promptAttachments([chip], fields, []), [chip]);
	});

	it("appends a different implicit selection after the chips", () => {
		const selected = { assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(promptAttachments([chip], selected, []), [chip, { type: "ui_selection", ...selected }]);
	});

	it("still omits an implicit selection already in the transcript", () => {
		const selected = { assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(
			promptAttachments([], selected, [{ attachments: [{ type: "ui_selection", ...selected }] }]),
			[],
		);
	});
});

describe("composer asset chips", () => {
	it("accepts a library-relative chip and ignores a duplicate id", () => {
		assert.deepEqual(parseComposerAssetInputs([chip, { ...chip }]), [chip]);
	});

	it("rejects a ui_selection row as a composer chip", () => {
		assert.throws(() => parseComposerAssetInputs([selection]));
	});

	it("reads stored asset_ref chips and skips a library highlight", () => {
		const highlight = { ...selection, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		assert.deepEqual(storedAssetRefs([chip, highlight]), [chip]);
	});

	it("rejects an absolute path", () => {
		assert.throws(() => parseComposerAssetInputs([{ ...chip, path: "/tmp/hero.mp4" }]));
		assert.throws(() => parseComposerAssetInputs([{ ...chip, path: "C:\\clips\\hero.mp4" }]));
		assert.deepEqual(storedAssetRefs([{ ...chip, path: "/tmp/hero.mp4" }]), []);
	});

	it("layout text is one space per chip", () => {
		const block = "<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>";
		assert.equal(composerLayoutText(`hello${block}world`), "hello world");
	});
});

describe("foldUserMessageForLlm", () => {
	it("leaves content alone when there are no attachments", () => {
		const message = { role: "user", content: [{ type: "text", text: "hello" }] };
		assert.equal(foldUserMessageForLlm(message), message);
	});

	it("folds an implicit selection into one string and keeps the stored row's attachments", () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "把这个处理一下" }],
			attachments: [selection],
		};
		assert.deepEqual(foldUserMessageForLlm(message), {
			...message,
			content: foldUserText("把这个处理一下", [selection]),
		});
		assert.match(
			String(foldUserMessageForLlm(message).content),
			/^把这个处理一下\n\n<system-reminder>\nThe user had this file selected in the library\. This may or may not be related to the current task\.\n\n<ui_selection>\npath: clips\/hero\.mp4\nasset_id: asset-1\ntype: video\n<\/ui_selection>\n<\/system-reminder>$/,
		);
	});

	it("keeps a chip already in the text and appends one that is missing", () => {
		const sitting = "看一下\n\n<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>\n\n这段";
		assert.equal(foldUserText(sitting, [chip]), sitting);
		assert.equal(
			foldUserText("看一下这段", [chip]),
			"看一下这段\n\n<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>",
		);
	});

	it("stores a placed chip in the text and keeps a different selection on attachments", () => {
		const other = { type: "ui_selection" as const, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		const stored = "看一下\n\n<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>\n\n这段";
		assert.equal(contentWithPlacedAssets(stored, [chip]), stored);
		assert.deepEqual(implicitSelectionAttachments([chip], other, []), [other]);
		assert.deepEqual(implicitSelectionAttachments([chip], fields, []), []);
		assert.equal(contentWithPlacedAssets(stored, [chip]), stored);
		assert.equal(stripInlineAssetRefs(stored).replace(/\s+/g, " ").trim(), "看一下 这段");
		const inline = `看一下<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>这段`;
		assert.equal(contentWithPlacedAssets(inline, [chip]), inline);
		const moved = { ...chip, path: "clips/moved.mp4" };
		assert.equal(
			contentWithPlacedAssets(inline, [moved]),
			`看一下<asset_ref>\npath: clips/moved.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>这段`,
		);
		const sent = foldUserMessageForLlm({ role: "user", content: stored, attachments: [other] });
		assert.equal(String(sent.content).match(/<asset_ref>/g)?.length, 1);
		assert.match(
			String(sent.content),
			/这段\n\n<system-reminder>\nThe user had this file selected in the library\. This may or may not be related to the current task\.\n\n<ui_selection>\npath: notes\/brief\.md\nasset_id: asset-2\ntype: text\n<\/ui_selection>\n<\/system-reminder>$/,
		);
		assert.deepEqual(splitStoredAssetText(stored), [
			{ type: "text", text: "看一下" },
			{ type: "asset", assetId: chip.assetId },
			{ type: "text", text: "这段" },
		]);
		assert.deepEqual(assetRefBlocks(stored), [chip]);
		assert.deepEqual(displayAssetRefs(stored, [other]).map((row) => row.assetId), [chip.assetId]);
		assert.deepEqual(
			splitStoredAssetText(stored).map((part) => part.type === "asset" ? part.assetId : part.text),
			["看一下", chip.assetId, "这段"],
		);
	});

	it("appends a selection that was not placed in the text", () => {
		const other = { type: "ui_selection" as const, assetId: "asset-2", path: "notes/brief.md", assetType: "text" as const };
		const text = "看一下\n\n<asset_ref>\npath: clips/hero.mp4\nasset_id: asset-1\ntype: video\n</asset_ref>\n\n这段";
		const folded = foldUserText(text, [chip, other]);
		assert.match(folded, /^看一下\n\n<asset_ref>\npath: clips\/hero\.mp4/);
		assert.match(
			folded,
			/这段\n\n<system-reminder>\nThe user had this file selected in the library\. This may or may not be related to the current task\.\n\n<ui_selection>\npath: notes\/brief\.md\nasset_id: asset-2\ntype: text\n<\/ui_selection>\n<\/system-reminder>$/,
		);
	});

	it("drops an image part and keeps the text", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		const image = { type: "image" as const, data: bytesToBase64(png), mimeType: "image/png" };
		const message = { role: "user", content: [{ type: "text", text: "look" }, image] };
		assert.deepEqual(foldUserMessageForLlm(message), { ...message, content: "look" });
	});

	it("rejects a file that is not a JPEG, PNG, GIF, or WebP", () => {
		assert.equal(sniffComposerImage(new Uint8Array([0, 1, 2, 3])), undefined);
		assert.throws(() => parseComposerImageInputs([{ filename: "x.txt", mimeType: "image/png", data: bytesToBase64(new Uint8Array([1, 2, 3, 4])) }]));
	});

	it("folds attachments into one string and drops image parts", () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const folded = foldUserMessageForLlm({
			role: "user",
			content: [{ type: "text", text: "look" }, image],
			attachments: [chip],
		});
		assert.equal(folded.content, foldUserText("look", [chip]));
	});
});
