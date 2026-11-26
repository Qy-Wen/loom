import type { ReactNode, Ref } from "react";
import { contentToText, type Message } from "@ag-ui/client";
import { transcriptItemKey, transcriptItems, transcriptMessageId, type TranscriptItem } from "./transcript.ts";
import { ToolCard } from "./tool-card.tsx";

export function renderDefaultTool(item: Extract<TranscriptItem, { kind: "tool" }>): ReactNode {
	return <ToolCard name={item.call.function.name} parameters={item.call.function.arguments} result={item.result?.content} defaultOpen={!item.result} />;
}

function renderDefaultItem(item: TranscriptItem): ReactNode {
	if (item.kind === "tool") {
		return renderDefaultTool(item);
	}
	const { message } = item;
	if (message.role === "activity" || message.role === "system" || message.role === "developer") return null;
	const text = contentToText(message.content);
	if (!text) return null;
	if (message.role === "reasoning") return <details><summary>Reasoning</summary><p className="agui-message-text">{text}</p></details>;
	return <p className="agui-message-text">{text}</p>;
}

export interface MessageListProps {
	messages: readonly Message[];
	renderItem?: (item: TranscriptItem) => ReactNode;
	label?: string;
}

export function TranscriptList({ items, renderItem = renderDefaultItem, label = "Conversation", listRef }: Omit<MessageListProps, "messages"> & {
	items: readonly TranscriptItem[];
	listRef?: Ref<HTMLOListElement>;
}) {
	return <ol className="agui-messages" aria-label={label} ref={listRef}>{items.map((item) => {
		const content = renderItem(item);
		if (content == null) return null;
		return <li
			key={transcriptItemKey(item)}
			data-message-id={transcriptMessageId(item)}
			data-role={item.kind === "tool" ? "tool" : item.message.role}
			tabIndex={-1}
		>{content}</li>;
	})}</ol>;
}

export function MessageList({ messages, ...props }: MessageListProps) {
	return <TranscriptList items={transcriptItems(messages)} {...props} />;
}
