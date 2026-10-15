import type { LoomToolContentPart } from "@loom/agent";

export function toolResultParts(value: unknown): LoomToolContentPart[] | null {
	let parsed = value;
	if (typeof parsed === "string") {
		try { parsed = JSON.parse(parsed) as unknown; } catch { return null; }
	}
	const content = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? (parsed as { content?: unknown }).content : undefined;
	if (!Array.isArray(content)) return null;
	const parts = content.flatMap((part): LoomToolContentPart[] => {
		if (!part || typeof part !== "object") return [];
		const record = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
		if (record.type === "text" && typeof record.text === "string") return [{ type: "text", text: record.text }];
		if (record.type === "image" && typeof record.data === "string" && record.data.length > 0 && typeof record.mimeType === "string" && /^image\/[a-z0-9.+-]+$/i.test(record.mimeType)) {
			return [{ type: "image", data: record.data, mimeType: record.mimeType }];
		}
		return [];
	});
	return parts.some((part) => part.type === "image") ? parts : null;
}
