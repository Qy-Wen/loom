import type { ReactNode } from "react";
import { contentToText, type Message } from "@ag-ui/client";
import { transcriptItems, type TranscriptItem } from "./transcript.ts";
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

export function MessageList({ messages, renderItem = renderDefaultItem, label = "Conversation" }: MessageListProps) {
	return <ol className="agui-messages" aria-label={label}>{transcriptItems(messages).map((item) => {
		const content = renderItem(item);
		return content == null ? null : <li key={item.kind === "tool" ? `tool:${item.call.id}` : item.message.id} data-role={item.kind === "tool" ? "tool" : item.message.role}>{content}</li>;
	})}</ol>;
}
