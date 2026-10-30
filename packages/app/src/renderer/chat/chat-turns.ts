import type { Message } from "@ag-ui/core";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";

/**
 * Ids of the replies that close a turn: the last assistant message before the next user message (or the end
 * of history), when it is plain text. A turn that ends in a tool call or a failed request has none, so
 * nothing offers to branch from a half-finished answer.
 */
export function turnEndReplyIds(messages: readonly Message[]): Set<string> {
	const ids = new Set<string>();
	let reply: string | null = null;
	for (const message of messages) {
		if (message.role === "user") {
			if (reply) ids.add(reply);
			reply = null;
		} else if (message.role === "assistant") {
			const text = typeof message.content === "string" ? message.content.trim() : "";
			reply = text && !message.toolCalls?.length && !isChatErrorMessageId(message.id) ? message.id : null;
		}
	}
	if (reply) ids.add(reply);
	return ids;
}
