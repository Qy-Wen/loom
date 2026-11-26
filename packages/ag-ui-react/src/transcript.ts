import type { Message, ToolCall, ToolMessage } from "@ag-ui/client";

export type TranscriptItem =
	| { kind: "message"; message: Message }
	| { kind: "tool"; call: ToolCall; result?: ToolMessage };

export function transcriptItemKey(item: TranscriptItem): string {
	return item.kind === "tool" ? `tool:${item.call.id}` : item.message.id;
}

export function transcriptMessageId(item: TranscriptItem): string | undefined {
	return item.kind === "tool" ? item.result?.id : item.message.id;
}

/** Prefer a turn boundary when there is one near the start of the page. */
export function transcriptPageStart(items: readonly TranscriptItem[], end: number, size: number): number {
	const start = Math.max(0, end - size);
	const boundaryLimit = start + Math.floor(size / 4);
	if (start === 0) return 0;
	for (let index = start; index <= boundaryLimit && index < end; index++) {
		const item = items[index];
		if (item?.kind === "message" && item.message.role === "user") return index;
	}
	return start;
}

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
