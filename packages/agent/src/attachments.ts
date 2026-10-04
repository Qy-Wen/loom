import { splitInlineAssetRefs } from "./composer-asset.ts";

/** Sidecar context on a stored user message. Folded into Chat `content` in convertToLlm. Composer pictures live on `content`, not here. */

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

/** The Chat endpoint refused a picture. The turn should be reported and left off the active path. */
export function chatRejectedImages(message: string): boolean {
	return /image_url|input_image|image input|do(?:es)? not support images?|multimodal|invalid content type|unknown content type|content must be (?:a )?string/i.test(message);
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

/** Fold selections into one string. A chip marker expands where it sits; other attachments are appended. */
export function foldUserText(text: string, attachments: readonly LoomUserAttachment[]): string {
	const byId = new Map<string, LoomUserAttachment>();
	for (const row of attachments) {
		if (!byId.has(row.assetId)) byId.set(row.assetId, row);
	}
	const used = new Set<string>();
	let out = "";
	for (const part of splitInlineAssetRefs(text)) {
		if (part.type === "text") {
			out += part.text;
			continue;
		}
		const row = byId.get(part.assetId);
		if (!row) continue;
		used.add(part.assetId);
		out = appendSelectionBlock(out, formatAttachmentBlock(row));
	}
	for (const row of attachments) {
		if (used.has(row.assetId)) continue;
		out = appendSelectionBlock(out, formatAttachmentBlock(row));
	}
	return out.replace(/\n+$/, "");
}

type ImagePart = { type: "image"; data: string; mimeType: string };

function imagePartsFromContent(content: unknown): ImagePart[] {
	if (!Array.isArray(content)) return [];
	const images: ImagePart[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const row = part as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (row.type === "image" && typeof row.data === "string" && typeof row.mimeType === "string") {
			images.push({ type: "image", data: row.data, mimeType: row.mimeType });
		}
	}
	return images;
}

/** Clone a user row for the provider: one text string, plus image parts already on `content`. */
export function foldUserMessageForLlm<T extends { role: string; content?: unknown; attachments?: unknown }>(message: T): T {
	if (message.role !== "user") return message;
	const attachments = parseUserAttachments(message.attachments);
	if (attachments.length === 0) return message;
	const folded = foldUserText(userTextFromContent(message.content), attachments);
	const images = imagePartsFromContent(message.content);
	if (images.length === 0) return { ...message, content: folded };
	if (!folded) return { ...message, content: images };
	return { ...message, content: [{ type: "text", text: folded }, ...images] };
}
