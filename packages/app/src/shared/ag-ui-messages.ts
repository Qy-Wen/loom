import type { Message, ToolCall } from "@ag-ui/core";
import type { LoomTranscriptMessage } from "@loom/agent";
import { splitStoredAssetText } from "@loom/agent/composer-asset";
import { CHAT_ERROR_ID_PREFIX, formatChatError } from "./chat-error.ts";

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
			out.push({ id, role: "user", content: userBubbleContent(message) });
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
				content: transcriptText(message.content),
			});
		}
	}
	return out;
}

function userBubbleContent(message: LoomTranscriptMessage): string {
	return transcriptText(message.content).replaceAll("\u200b", "");
}

function textOf(message: Message): string {
	const content = "content" in message ? message.content : "";
	return transcriptText(content).replaceAll("\u200b", "");
}

/** Words plus placed asset ids, so spacing around a chip does not look like a new turn. */
function comparableUserText(text: string): string {
	const parts = splitStoredAssetText(text);
	const words = parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("").replace(/\s+/g, " ").trim();
	const ids = parts.flatMap((part) => part.type === "asset" ? [part.assetId] : []).sort();
	return `${words}\0${ids.join(",")}`;
}

function fingerprint(message: Message): string {
	const text = textOf(message);
	return `${message.role}:${message.role === "user" ? comparableUserText(text) : text}`;
}

function overlayComposerImages(stored: Message[], live: Message[]): Message[] {
	return live.map((message, index) => {
		const prior = stored[index];
		if (!prior || prior.role !== "user" || message.role !== "user") return message;
		if (comparableUserText(textOf(prior)) !== comparableUserText(textOf(message))) return message;
		if (textOf(prior) === textOf(message) && !Array.isArray(prior.content)) return message;
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

/**
 * A later user message that disk does not have yet. Reasoning ids from the
 * previous turn often differ (`think-…` versus the saved entry), which looks
 * like a branch and would otherwise hide this turn until the run finishes.
 */
function continuation(stored: Message[], live: Message[]): Message[] | null {
	const storedUsers = new Set(stored.flatMap((message) => message.role === "user" && message.id ? [message.id] : []));
	const start = live.findIndex((message) => message.role === "user" && !!message.id && !storedUsers.has(message.id));
	if (start < 0) return null;
	return [...stored, ...live.slice(start)];
}

/** Replace one on-screen message id with the entry id assigned when it was saved. */
export function adoptMessageId(messages: readonly Message[], fromId: string, entryId: string): Message[] | null {
	const index = messages.findIndex((message) => message.id === fromId);
	if (index < 0 || messages[index]?.id === entryId) return null;
	const next = messages.slice();
	next[index] = { ...messages[index]!, id: entryId };
	return next;
}

/** Point the latest on-screen user message at the entry id assigned when it was saved. */
export function adoptUserEntryId(messages: readonly Message[], entryId: string): Message[] | null {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		if (message.id === entryId) return null;
		const next = messages.slice();
		next[index] = { ...message, id: entryId };
		return next;
	}
	return null;
}

/** A user message whose id was not already on this list. */
export function freshUserTurn(messages: readonly Message[], beforeIds: ReadonlySet<string>): boolean {
	return messages.some((message) => message.role === "user" && !!message.id && !beforeIds.has(message.id));
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

/** Show disk history when the live agent is empty; append new turns; avoid duplicates. */
export function mergeChatMessages(stored: Message[], live: Message[]): Message[] {
	if (stored.length === 0) return live;
	if (live.length === 0) return stored;
	if (fingerprint(stored[0]!) === fingerprint(live[0]!)) {
		if (diverged(stored, live)) return continuation(stored, live) ?? stored;
		const chosen = live.length >= stored.length ? live : stored;
		return chosen === live ? overlayComposerImages(stored, live) : stored;
	}
	return [...stored, ...live];
}
