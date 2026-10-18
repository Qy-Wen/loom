import { assetRefBlocks, replaceAssetRefBlocks } from "./composer-asset.ts";

/** Send-time context folded into durable model content before submit. */

export type LoomAssetType = "image" | "video" | "audio" | "text" | "other";

export type UiSelectionFields = {
	assetId: string;
	path: string;
	assetType: LoomAssetType;
};

/** The library file highlighted when the user sent the message. At most one per turn. */
export type UiSelectionAttachment = UiSelectionFields & {
	type: "ui_selection";
};

/** A library file the user placed in the composer. Several per turn, keyed by assetId. */
export type AssetRefAttachment = UiSelectionFields & {
	type: "asset_ref";
};

export type LoomUserAttachment = UiSelectionAttachment | AssetRefAttachment;

const ASSET_TYPES = new Set<string>(["image", "video", "audio", "text", "other"]);

function isAssetFields(row: Record<string, unknown>): row is Record<string, unknown> & UiSelectionFields {
	return (
		typeof row.assetId === "string" &&
		row.assetId.trim() !== "" &&
		typeof row.path === "string" &&
		ASSET_TYPES.has(String(row.assetType))
	);
}

export function isUiSelectionAttachment(value: unknown): value is UiSelectionAttachment {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return row.type === "ui_selection" && isAssetFields(row);
}

export function isAssetRefAttachment(value: unknown): value is AssetRefAttachment {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return row.type === "asset_ref" && isAssetFields(row);
}

export function isLoomUserAttachment(value: unknown): value is LoomUserAttachment {
	return isUiSelectionAttachment(value) || isAssetRefAttachment(value);
}

export function parseUserAttachments(value: unknown): LoomUserAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isLoomUserAttachment);
}

function messageAttachments(message: unknown): unknown {
	if (typeof message !== "object" || message === null) return undefined;
	return (message as { attachments?: unknown }).attachments;
}

export function latestUiSelectionAssetId(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const attachments = parseUserAttachments(messageAttachments(messages[i]));
		for (let j = attachments.length - 1; j >= 0; j--) {
			const row = attachments[j];
			if (row?.type === "ui_selection") return row.assetId;
		}
		const message = messages[i] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user") continue;
		const text = userTextFromContent(message.content);
		const blocks = [...text.matchAll(/<system-reminder>\s*The user had this file selected in the library\.[\s\S]*?<ui_selection>\s*path: [^\n]*\nasset_id: ([^\n]+)\ntype: [^\n]*\n<\/ui_selection>\s*<\/system-reminder>/g)];
		const id = blocks.at(-1)?.[1]?.trim();
		if (id) return id;
	}
	return undefined;
}

/** Attach this send's selection only when it is new relative to the transcript. */
export function uiSelectionToAttach(
	selection: UiSelectionFields | null | undefined,
	messages: readonly unknown[],
): UiSelectionAttachment | undefined {
	if (!selection?.assetId.trim() || !ASSET_TYPES.has(selection.assetType)) return undefined;
	if (latestUiSelectionAssetId(messages) === selection.assetId) return undefined;
	return {
		type: "ui_selection",
		assetId: selection.assetId,
		path: selection.path,
		assetType: selection.assetType,
	};
}

/**
 * Placed chips are stored already expanded inside the user text.
 * The library highlight is folded after the text before submit.
 */
export function contentWithPlacedAssets(text: string, chips: readonly AssetRefAttachment[]): string {
	const byId = new Map(chips.map((chip) => [chip.assetId, chip]));
	const refreshed = replaceAssetRefBlocks(text, (block) => {
		const chip = byId.get(block.assetId);
		if (!chip || (chip.path === block.path && chip.assetType === block.assetType)) return null;
		return formatAssetRefBlock(chip);
	});
	if (chips.length === 0) return refreshed;
	return foldUserText(refreshed, chips);
}

/** Same send rules as `promptAttachments`, keeping only the implicit library highlight. */
export function implicitSelectionAttachments(
	chips: readonly AssetRefAttachment[],
	selection: UiSelectionFields | null | undefined,
	messages: readonly unknown[],
): LoomUserAttachment[] {
	return promptAttachments(chips, selection, messages).filter((row) => row.type === "ui_selection");
}

/** Explicit composer chips (`asset_ref`), then the implicit library highlight (`ui_selection`) when it is not already included. */
export function promptAttachments(
	chips: readonly AssetRefAttachment[],
	selection: UiSelectionFields | null | undefined,
	messages: readonly unknown[],
): LoomUserAttachment[] {
	const out: LoomUserAttachment[] = [];
	const seen = new Set<string>();
	for (const chip of chips) {
		if (!isAssetRefAttachment(chip) || seen.has(chip.assetId)) continue;
		seen.add(chip.assetId);
		out.push(chip);
	}
	const implicit = uiSelectionToAttach(selection, messages);
	if (implicit && !seen.has(implicit.assetId)) out.push(implicit);
	return out;
}

export function userTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : String(content);
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part !== "object" || part === null) return "";
			const row = part as { type?: unknown; text?: unknown };
			if (row.type === "image") return "";
			return typeof row.text === "string" ? row.text : "";
		})
		.join("");
}

export function formatUiSelectionBlock(attachment: UiSelectionAttachment): string {
	return formatAssetBlock("ui_selection", attachment);
}

export function formatAssetRefBlock(attachment: AssetRefAttachment): string {
	return formatAssetBlock("asset_ref", attachment);
}

function formatAssetBlock(tag: LoomUserAttachment["type"], attachment: UiSelectionFields): string {
	return (
		`<${tag}>\n` +
		`path: ${attachment.path}\n` +
		`asset_id: ${attachment.assetId}\n` +
		`type: ${attachment.assetType}\n` +
		`</${tag}>`
	);
}

function formatAttachmentBlock(attachment: LoomUserAttachment): string {
	return attachment.type === "asset_ref"
		? formatAssetRefBlock(attachment)
		: formatUiSelectionBlock(attachment);
}

function appendSelectionBlock(text: string, block: string): string {
	const base = text.replace(/[ \t\n]+$/g, "");
	if (!base) return `${block}\n\n`;
	return `${base}\n\n${block}\n\n`;
}

/** App-attached context, in the same user message but outside the words the user typed. */
function formatImplicitContext(rows: readonly LoomUserAttachment[]): string {
	const intro =
		rows.length === 1
			? "The user had this file selected in the library. This may or may not be related to the current task."
			: "The user had these files selected in the library. This may or may not be related to the current task.";
	const body = rows.map((row) => formatAttachmentBlock(row)).join("\n\n");
	return `<system-reminder>\n${intro}\n\n${body}\n</system-reminder>`;
}

/** Append a chip or library highlight the text does not already name. */
export function foldUserText(text: string, attachments: readonly LoomUserAttachment[]): string {
	const used = new Set(assetRefBlocks(text).map((row) => row.assetId));
	let out = text;
	const implicit: LoomUserAttachment[] = [];
	for (const row of attachments) {
		if (used.has(row.assetId)) continue;
		if (row.type === "ui_selection") {
			implicit.push(row);
			continue;
		}
		used.add(row.assetId);
		out = appendSelectionBlock(out, formatAttachmentBlock(row));
	}
	if (implicit.length > 0) out = appendSelectionBlock(out, formatImplicitContext(implicit));
	return out.replace(/\n+$/, "");
}
