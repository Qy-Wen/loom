import type { Message, ToolCall } from "@ag-ui/core";
import type { LoomTranscriptMessage } from "@loom/agent";

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

/** Non-redacted thinking text. Signatures stay on the transcript and are not copied. */
function visibleThinking(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const record = part as { type?: unknown; thinking?: unknown; redacted?: unknown };
			if (record.type !== "thinking" || record.redacted === true || typeof record.thinking !== "string") return "";
			return record.thinking;
		})
		.filter((text) => text.trim().length > 0)
		.join("\n\n");
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
			out.push({ id, role: "user", content: userBubbleContent(message) });
			continue;
		}
		if (message.role === "assistant") {
			const thinking = visibleThinking(message.content);
			if (thinking) out.push({ id: `${id}-thinking`, role: "reasoning", content: thinking });
			const toolCalls = assistantToolCalls(message.content);
			out.push({
				id,
				role: "assistant",
				content: transcriptText(message.content),
				...(toolCalls.length ? { toolCalls } : {}),
			});
			continue;
		}
		if (message.role === "compactionSummary") {
			const summary = typeof message.summary === "string" ? message.summary : "";
			const tokens = typeof message.tokensBefore === "number" ? message.tokensBefore : undefined;
			const note = tokens !== undefined
				? `Context compacted from ~${tokens.toLocaleString()} tokens.`
				: "Context compacted.";
			out.push({ id, role: "assistant", content: `${note}\n\n${summary}` });
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

function contentImageParts(content: unknown): Array<{ type: "image"; source: { type: "data"; value: string; mimeType: string } }> {
	if (!Array.isArray(content)) return [];
	const images = [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const record = part as { type?: unknown; data?: unknown; mimeType?: unknown };
		if (record.type !== "image" || typeof record.data !== "string" || typeof record.mimeType !== "string") continue;
		images.push({ type: "image" as const, source: { type: "data" as const, value: record.data, mimeType: record.mimeType } });
	}
	return images;
}

function userBubbleContent(message: LoomTranscriptMessage): string | Array<{ type: "text"; text: string } | { type: "image"; source: { type: "data"; value: string; mimeType: string } }> {
	const text = transcriptText(message.content).replaceAll("\u200b", "");
	const images = contentImageParts(message.content);
	if (images.length === 0) return text;
	return [...(text ? [{ type: "text" as const, text }] : []), ...images];
}

function textOf(message: Message): string {
	const content = "content" in message ? message.content : "";
	return transcriptText(content).replaceAll("\u200b", "");
}

function fingerprint(message: Message): string {
	return `${message.role}:${textOf(message)}`;
}

function overlayComposerImages(stored: Message[], live: Message[]): Message[] {
	return live.map((message, index) => {
		const prior = stored[index];
		if (!prior || prior.role !== "user" || message.role !== "user") return message;
		if (!Array.isArray(prior.content) || textOf(prior) !== textOf(message)) return message;
		return { ...message, content: prior.content };
	});
}

/**
 * Same ids, then a different successor: the live list is a path we already left.
 * A new session's first disk reload uses harness ids while the stream uses its own,
 * so a mismatch before any shared id is not a branch.
 */
function diverged(stored: Message[], live: Message[]): boolean {
	const limit = Math.min(stored.length, live.length);
	let matched = false;
	for (let index = 0; index < limit; index++) {
		const storedId = stored[index]?.id;
		const liveId = live[index]?.id;
		if (!storedId || !liveId) return false;
		if (storedId !== liveId) return matched;
		matched = true;
	}
	return false;
}

/** Show disk history when the live agent is empty; append new turns; avoid duplicates. */
export function mergeChatMessages(stored: Message[], live: Message[]): Message[] {
	if (stored.length === 0) return live;
	if (live.length === 0) return stored;
	if (fingerprint(stored[0]!) === fingerprint(live[0]!)) {
		if (diverged(stored, live)) return stored;
		const chosen = live.length >= stored.length ? live : stored;
		return chosen === live ? overlayComposerImages(stored, live) : stored;
	}
	return [...stored, ...live];
}
