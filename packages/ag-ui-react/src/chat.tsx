import { useState } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { MessageComposer, type MessageComposerProps } from "./composer.tsx";
import { MessageList, type MessageListProps } from "./message-list.tsx";
import { useAgent } from "./use-agent.ts";

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
