/** Sidecar context on a stored user message. Folded into Chat `content` in convertToLlm. Composer pictures live on `content`, not here. */

export type LoomAssetType = "image" | "video" | "audio" | "text" | "other";

export type UiSelectionAttachment = {
	type: "ui_selection";
	assetId: string;
	path: string;
	assetType: LoomAssetType;
};

export type LoomUserAttachment = UiSelectionAttachment;

export type UiSelectionFields = {
	assetId: string;
	path: string;
	assetType: LoomAssetType;
};

const ASSET_TYPES = new Set<string>(["image", "video", "audio", "text", "other"]);

export function isUiSelectionAttachment(value: unknown): value is UiSelectionAttachment {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		row.type === "ui_selection" &&
		typeof row.assetId === "string" &&
		row.assetId.trim() !== "" &&
		typeof row.path === "string" &&
		ASSET_TYPES.has(String(row.assetType))
	);
}

/** The Chat endpoint refused a picture. The turn should be reported and left off the active path. */
export function chatRejectedImages(message: string): boolean {
	return /image_url|input_image|image input|do(?:es)? not support images?|multimodal|invalid content type|unknown content type|content must be (?:a )?string/i.test(message);
}

export function parseUserAttachments(value: unknown): LoomUserAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isUiSelectionAttachment);
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
	return (
		`<ui_selection>\n` +
		`path: ${attachment.path}\n` +
		`asset_id: ${attachment.assetId}\n` +
		`type: ${attachment.assetType}\n` +
		`</ui_selection>`
	);
}

export function foldUserText(text: string, attachments: readonly LoomUserAttachment[]): string {
	if (attachments.length === 0) return text;
	const blocks = attachments.map((row) => {
		if (row.type === "ui_selection") return formatUiSelectionBlock(row);
		return "";
	}).filter(Boolean);
	if (blocks.length === 0) return text;
	if (!text) return blocks.join("\n\n");
	return `${text}\n\n${blocks.join("\n\n")}`;
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
