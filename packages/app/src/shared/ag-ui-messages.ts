import type { Message, ToolCall } from "@ag-ui/core";
import type { LoomTranscriptMessage } from "@loom/core";

export function transcriptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : String(content);
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (typeof part !== "object" || part === null) return "";
			const record = part as { text?: unknown };
			return typeof record.text === "string" ? record.text : "";
		})
		.join("");
}

function assistantToolCalls(content: unknown): ToolCall[] {
	if (!Array.isArray(content)) return [];
	const calls: ToolCall[] = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (record.type !== "toolCall" || typeof record.id !== "string" || typeof record.name !== "string") continue;
		calls.push({
			id: record.id,
			type: "function",
			function: {
				name: record.name,
				arguments: typeof record.arguments === "string" ? record.arguments : JSON.stringify(record.arguments ?? {}),
			},
		});
	}
	return calls;
}

/** Map persisted pi/Loom transcript messages into AG-UI chat messages. */
export function toAgUiMessages(messages: LoomTranscriptMessage[]): Message[] {
	const out: Message[] = [];
	for (const [index, message] of messages.entries()) {
		const id = typeof message.id === "string" && message.id ? message.id : `loom-${index}`;
		if (message.role === "user") {
			out.push({ id, role: "user", content: transcriptText(message.content) });
			continue;
		}
		if (message.role === "assistant") {
			const toolCalls = assistantToolCalls(message.content);
			out.push({
				id,
				role: "assistant",
				content: transcriptText(message.content),
				...(toolCalls.length ? { toolCalls } : {}),
			});
			continue;
		}
		if (message.role === "toolResult" || message.role === "tool") {
			out.push({
				id,
				role: "tool",
				toolCallId: String(message.toolCallId ?? id),
				content: transcriptText(message.content),
			});
		}
	}
	return out;
}

function fingerprint(message: Message): string {
	const content = "content" in message && typeof message.content === "string" ? message.content : "";
	return `${message.role}:${content}`;
}

/** Show disk history when the live agent is empty; append new turns; avoid duplicates. */
export function mergeChatMessages(stored: Message[], live: Message[]): Message[] {
	if (stored.length === 0) return live;
	if (live.length === 0) return stored;
	if (fingerprint(stored[0]!) === fingerprint(live[0]!)) {
		return live.length >= stored.length ? live : stored;
	}
	return [...stored, ...live];
}
