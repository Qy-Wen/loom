import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { contentToText, type ActivityMessage, type AssistantMessage, type Message, type UserMessage } from "@ag-ui/client";
import { MessageList, renderDefaultTool } from "./message-list.tsx";
import { Markdown, type MarkdownProps } from "./markdown.tsx";
import { MessageRow, ReasoningRow } from "./message-row.tsx";
import type { TranscriptItem } from "./transcript.ts";
import { useChatScroll } from "./use-chat-scroll.ts";

export interface ChatMessageParts {
	content?: ReactNode;
	actions?: ReactNode;
	/** Replaces the row, for example with an editor or an error. */
	replacement?: ReactNode;
}

export interface ChatMarkdownOptions {
	linkComponent?: MarkdownProps["linkComponent"];
	prepareContent?: (text: string) => { markdown: string; trailing?: ReactNode };
}

export interface ChatViewSlots {
	markdown?: ChatMarkdownOptions;
	userMessage?: (message: UserMessage, text: string) => ChatMessageParts | undefined;
	assistantMessage?: (message: AssistantMessage, text: string) => ChatMessageParts | undefined;
	tool?: (item: Extract<TranscriptItem, { kind: "tool" }>) => ReactNode;
	activity?: (message: ActivityMessage) => ReactNode;
}

export interface ChatViewProps {
	messages: readonly Message[];
	isRunning?: boolean;
	/** Reset scroll following when the conversation changes. */
	threadId?: string;
	className?: string;
	emptyState?: ReactNode;
	labels?: { conversation?: string; working?: string; latest?: string; reasoning?: string; copy?: string };
	slots?: ChatViewSlots;
}

function MarkdownBody({ content, options }: { content: string; options?: ChatMarkdownOptions }) {
	const prepared = useMemo(() => options?.prepareContent?.(content) ?? { markdown: content }, [content, options]);
	return <>
		{prepared.markdown && <Markdown content={prepared.markdown} linkComponent={options?.linkComponent} />}
		{prepared.trailing}
	</>;
}

/** Controlled transcript with message rows and scroll following. The host supplies the messages. */
export function ChatView({ messages, isRunning, threadId, className, emptyState, labels, slots }: ChatViewProps) {
	const { scrollerProps, scrollToBottom, showJumpToLatest } = useChatScroll();
	const lastUserId = messages.findLast((message) => message.role === "user")?.id;
	const seenUserId = useRef<string | null>(null);

	useLayoutEffect(() => {
		if (!lastUserId || lastUserId === seenUserId.current) return;
		const isNewUserMessage = seenUserId.current !== null;
		seenUserId.current = lastUserId;
		if (isNewUserMessage) scrollToBottom();
	}, [lastUserId, scrollToBottom]);

	useLayoutEffect(() => {
		scrollToBottom();
	}, [threadId, scrollToBottom]);

	const copyLabel = labels?.copy ?? "Copy";
	const last = messages.findLast((message) => message.role === "assistant" || message.role === "tool" || message.role === "user" || message.role === "reasoning");
	const waiting = isRunning && (last?.role !== "assistant" || !last.content);

	function renderItem(item: TranscriptItem): ReactNode {
		if (item.kind === "tool") return slots?.tool ? slots.tool(item) : renderDefaultTool(item);
		const { message } = item;
		switch (message.role) {
			case "user": {
				const text = contentToText(message.content).replaceAll("\u200b", "");
				const parts = slots?.userMessage?.(message, text);
				if (parts?.replacement !== undefined) return parts.replacement;
				return <MessageRow role="user" text={text} copyLabel={copyLabel} actions={parts?.actions}>
					{parts?.content ?? <div className="agui-message-text">{text}</div>}
				</MessageRow>;
			}
			case "assistant": {
				if (!message.content) return null;
				const text = message.content.replaceAll("\u200b", "");
				const parts = slots?.assistantMessage?.(message, text);
				if (parts?.replacement !== undefined) return parts.replacement;
				if (!text.trim()) return null;
				return <MessageRow role="assistant" text={text} copyLabel={copyLabel} actions={parts?.actions}>
					{parts?.content ?? <MarkdownBody content={text} options={slots?.markdown} />}
				</MessageRow>;
			}
			case "reasoning":
				return message.content ? <ReasoningRow label={labels?.reasoning ?? "Reasoning"}>
					<MarkdownBody content={message.content.replaceAll("\u200b", "")} options={slots?.markdown} />
				</ReasoningRow> : null;
			case "activity": return slots?.activity?.(message);
			default: return null;
		}
	}

	return <div className={className ? `agui-chat-view ${className}` : "agui-chat-view"}>
		<div className="agui-chat-viewport" {...scrollerProps}>
			{messages.length === 0 && emptyState}
			<div className="agui-chat-transcript" data-testid="chat-message-list">
				<MessageList messages={messages} label={labels?.conversation} renderItem={renderItem} />
				{waiting && <div className="agui-chat-working" data-testid="chat-working" role="status" aria-label={labels?.working ?? "Working…"}><span aria-hidden="true" /></div>}
			</div>
		</div>
		{showJumpToLatest && <button type="button" className="agui-chat-jump" onClick={scrollToBottom}>{labels?.latest ?? "Latest"}</button>}
	</div>;
}
