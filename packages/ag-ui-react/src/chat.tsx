import { useState, type ReactNode } from "react";
import { contentToText, type AbstractAgent, type Message } from "@ag-ui/client";
import { MessageComposer, type MessageComposerProps } from "./composer.tsx";
import { transcriptItems, type TranscriptItem } from "./transcript.ts";
import { useAgent } from "./use-agent.ts";

function defaultItem(item: TranscriptItem): ReactNode {
	if (item.kind === "tool") {
		return <details><summary>{item.call.function.name}</summary>
			<pre className="agui-message-text">{item.call.function.arguments}</pre>
			{item.result && <pre className="agui-message-text">{contentToText(item.result.content)}</pre>}
		</details>;
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

export function MessageList({ messages, renderItem = defaultItem, label = "Conversation" }: MessageListProps) {
	return <ol className="agui-messages" aria-label={label}>{transcriptItems(messages).map((item) => {
		const content = renderItem(item);
		return content == null ? null : <li key={item.kind === "tool" ? `tool:${item.call.id}` : item.message.id} data-role={item.kind === "tool" ? "tool" : item.message.role}>{content}</li>;
	})}</ol>;
}

export interface ChatProps {
	agent: AbstractAgent;
	renderItem?: MessageListProps["renderItem"];
	labels?: MessageComposerProps["labels"] & { conversation?: string; running?: string };
}

/** A small default chat. Use the hook and primitives for a custom layout. */
export function Chat({ agent, renderItem, labels }: ChatProps) {
	const { messages, isRunning, send, stop, error } = useAgent(agent);
	const [failure, setFailure] = useState<string | null>(null);
	return <div className="agui-chat">
		<MessageList messages={messages} renderItem={renderItem} label={labels?.conversation} />
		<div role="status">{isRunning ? labels?.running ?? "Working…" : ""}</div>
		{(error ?? failure) && <p role="alert">{error ?? failure}</p>}
		<MessageComposer labels={labels} isRunning={isRunning} onStop={stop} onSend={(text) => {
			setFailure(null);
			void send(text).catch((cause: unknown) => {
				if (!(cause instanceof Error && cause.name === "AbortError")) setFailure(cause instanceof Error ? cause.message : String(cause));
			});
		}} />
	</div>;
}
