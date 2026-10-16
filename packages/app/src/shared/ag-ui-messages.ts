import type { Message, ToolCall } from "@ag-ui/core";
import type { LoomTranscriptMessage } from "@loom/agent";
import { CHAT_ERROR_ID_PREFIX, formatChatError } from "./chat-error.ts";
import { toolResultParts } from "./tool-result-content.ts";

export function toolResultContent(content: unknown): string {
	return Array.isArray(content) && toolResultParts(content) ? JSON.stringify({ content }) : transcriptText(content);
}

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

function assistantStop(message: LoomTranscriptMessage): string | undefined {
	return typeof message.stopReason === "string" ? message.stopReason : undefined;
}

/** Failed or cancelled assistant rows with nothing to show. Retries persist one of these per attempt. */
function isBlankTerminalAssistant(message: LoomTranscriptMessage): boolean {
	const stop = assistantStop(message);
	if (message.role !== "assistant") return false;
	if (stop !== "error" && stop !== "aborted" && stop !== "deferred") return false;
	if (transcriptText(message.content).trim()) return false;
	if (visibleThinking(message.content)) return false;
	if (assistantToolCalls(message.content).length > 0) return false;
	return true;
}

function pushAssistant(out: Message[], message: LoomTranscriptMessage, id: string): void {
	const thinking = visibleThinking(message.content);
	if (thinking) out.push({ id: `${id}-thinking`, role: "reasoning", content: thinking });
	const toolCalls = assistantToolCalls(message.content);
	out.push({
		id,
		role: "assistant",
		content: transcriptText(message.content),
		...(toolCalls.length ? { toolCalls } : {}),
	});
}

/** Map persisted pi/Loom transcript messages into AG-UI chat messages. */
export function toAgUiMessages(messages: LoomTranscriptMessage[]): Message[] {
	const out: Message[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]!;
		const id = typeof message.id === "string" && message.id ? message.id : `loom-${index}`;
		if (message.role === "user") {
			out.push({ id, role: "user", content: userBubbleContent(message), ...(typeof message.clientMessageId === "string" && message.clientMessageId ? { metadata: { "loom.clientMessageId": message.clientMessageId } } : {}) });
			continue;
		}
		if (message.role === "assistant" && isBlankTerminalAssistant(message)) {
			let end = index;
			while (end + 1 < messages.length && isBlankTerminalAssistant(messages[end + 1]!)) end++;
			const next = messages[end + 1];
			const recovered = next?.role === "assistant" && !isBlankTerminalAssistant(next);
			if (!recovered) {
				let failure = messages[end]!;
				for (let cursor = end; cursor >= index; cursor--) {
					if (assistantStop(messages[cursor]!) === "error") {
						failure = messages[cursor]!;
						break;
					}
				}
				if (assistantStop(failure) === "error") {
					const failureId = typeof failure.id === "string" && failure.id ? failure.id : `loom-${end}`;
					const detail = typeof failure.errorMessage === "string" ? failure.errorMessage : "";
					out.push({
						id: `${CHAT_ERROR_ID_PREFIX}${failureId}`,
						role: "assistant",
						content: formatChatError(detail),
					});
				}
			}
			index = end;
			continue;
		}
		if (message.role === "assistant") {
			pushAssistant(out, message, id);
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
				content: toolResultContent(message.content),
			});
		}
	}
	return out;
}

function userBubbleContent(message: LoomTranscriptMessage): string {
	return transcriptText(message.displayContent ?? message.content).replaceAll("\u200b", "");
}

/** Rename the streamed answer and its reasoning together when durable assigns the entry ID. */
export function adoptMessageId(messages: readonly Message[], fromId: string, entryId: string): Message[] | null {
	if (fromId === entryId || !messages.some((message) => message.id === fromId || message.id === `${fromId}-thinking`)) return null;
	return messages.map((message) => {
		if (message.id === fromId) return { ...message, id: entryId };
		if (message.id === `${fromId}-thinking`) return { ...message, id: `${entryId}-thinking` };
		return message;
	});
}

/**
 * One shared agent holds a single thread. Its live messages belong to
 * `agentSessionId`. Another open session must not paint them: a send would
 * otherwise sit under the previous transcript, and opening that session
 * would show the new turn.
 * `hidden` is the list captured at the switch; it stays hidden until the
 * agent replaces it.
 */
export function liveMessagesForSession(
	sessionId: string,
	agentSessionId: string,
	live: readonly Message[],
	hidden: readonly Message[] | null,
): Message[] {
	if (!sessionId || agentSessionId !== sessionId) return [];
	if (hidden !== null && live === hidden) return [];
	return live as Message[];
}

/** Durable rows are authoritative. Overlay only uncommitted/live rows, using IDs rather than text or list lengths. */
export function mergeChatMessages(stored: Message[], live: Message[]): Message[] {
	const committed = new Set(stored.map((message) => message.id));
	for (const message of stored) {
		const clientId = message.metadata?.["loom.clientMessageId"];
		if (typeof clientId === "string") committed.add(clientId);
	}
	const byId = new Map(live.map((message) => [message.id, message]));
	const history = stored.map((message) => {
		const current = byId.get(message.id);
		if (message.role !== "assistant" || current?.role !== "assistant") return message;
		// Specialist activity can add child calls to an already committed parent row.
		const calls = new Set(message.toolCalls?.map((call) => call.id));
		const added = current.toolCalls?.filter((call) => !calls.has(call.id)) ?? [];
		return added.length ? { ...message, toolCalls: [...(message.toolCalls ?? []), ...added] } : message;
	});
	return [...history, ...live.filter((message) => !committed.has(message.id))];
}
