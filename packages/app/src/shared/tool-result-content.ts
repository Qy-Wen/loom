import type { LoomToolContentPart } from "@loom/agent";

export type ToolImagePart = Extract<LoomToolContentPart, { type: "image" }> | { type: "image"; url: string; mimeType: string };
export type ToolContentPart = Extract<LoomToolContentPart, { type: "text" }> | ToolImagePart;

export function toolResultParts(value: unknown): ToolContentPart[] | null {
	let parsed = value;
	if (typeof parsed === "string") {
		try { parsed = JSON.parse(parsed) as unknown; } catch { return null; }
	}
	const content = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { content?: unknown }).content : undefined;
	if (!Array.isArray(content)) return null;
	const parts = content.flatMap((part): ToolContentPart[] => {
		if (!part || typeof part !== "object") return [];
		const record = part as { type?: unknown; text?: unknown; data?: unknown; url?: unknown; mimeType?: unknown };
		if (record.type === "text" && typeof record.text === "string") return [{ type: "text", text: record.text }];
		if (record.type === "image" && typeof record.url === "string" && /^loom-asset:\/\/chat-image\/[1-9]\d*\/[1-9]\d*\/\d+$/.test(record.url) && typeof record.mimeType === "string" && /^image\/[a-z0-9.+-]+$/i.test(record.mimeType)) {
			return [{ type: "image", url: record.url, mimeType: record.mimeType }];
		}
		if (record.type === "image" && typeof record.data === "string" && record.data.length > 0 && typeof record.mimeType === "string" && /^image\/[a-z0-9.+-]+$/i.test(record.mimeType)) {
			return [{ type: "image", data: record.data, mimeType: record.mimeType }];
		}
		return [];
	});
	return parts.some((part) => part.type === "image") ? parts : null;
}
