import type { LoomSessionRecord, LoomTranscriptMessage } from "@loom/agent";

/** Renderer records contain media references. Original image bytes stay in durable history. */
export function chatContent(content: unknown, sessionId: string, entryId: string): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((part, index) => {
		if (!part || part.type !== "image" || typeof part.data !== "string") return part;
		return { type: "image", mimeType: part.mimeType, url: `loom-asset://chat-image/${sessionId}/${entryId}/${index}` };
	});
}

export function chatRecord(record: LoomSessionRecord): LoomSessionRecord {
	return {
		...record,
		messages: record.messages.map((message): LoomTranscriptMessage => ({
			...message,
			content: chatContent(message.content, record.id, String(message.id)),
		})),
	};
}
