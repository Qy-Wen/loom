import type { LoomToolResult } from "@loom/agent";
import type { McpToolResult } from "./types.ts";

/** Unwrap embedded text/images; other blocks keep the common tool adapter's JSON representation. */
export function mcpToolContent(result: McpToolResult): LoomToolResult["content"] {
	if (typeof result.content === "string" && result.content) return result.content;
	const content = typeof result.content === "string" ? [] : result.content.map((part) => {
		if (part.type !== "resource") return part;
		const resource = (part as Record<string, unknown>).resource;
		if (!resource || typeof resource !== "object") return part;
		const row = resource as Record<string, unknown>;
		if (typeof row.text === "string") return { type: "text", text: row.text };
		if (typeof row.blob === "string" && typeof row.mimeType === "string" && row.mimeType.startsWith("image/")) {
			return { type: "image", data: row.blob, mimeType: row.mimeType };
		}
		return part;
	});
	if (content.length > 0 || result.structuredContent === undefined) return typeof result.content === "string" ? result.content : content;
	return [{ type: "text", text: JSON.stringify(result.structuredContent, null, 2) }];
}
