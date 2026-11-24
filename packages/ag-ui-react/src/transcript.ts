import type { Message, ToolCall, ToolMessage } from "@ag-ui/client";

export type TranscriptItem =
	| { kind: "message"; message: Message }
	| { kind: "tool"; call: ToolCall; result?: ToolMessage };

/** Keep calls next to their parent message and pair results by tool call ID. */
export function transcriptItems(messages: readonly Message[]): TranscriptItem[] {
	const results = new Map<string, ToolMessage>();
	const calls = new Set<string>();
	for (const message of messages) {
		if (message.role === "tool") results.set(message.toolCallId, message);
		if (message.role === "assistant") for (const call of message.toolCalls ?? []) calls.add(call.id);
	}
	return messages.flatMap((message): TranscriptItem[] => {
		if (message.role === "tool" && calls.has(message.toolCallId)) return [];
		const item = { kind: "message", message } as const;
		if (message.role !== "assistant") return [item];
		return [item, ...message.toolCalls?.map((call) => ({ kind: "tool" as const, call, result: results.get(call.id) })) ?? []];
	});
}
