import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { contentToText, type ActivityMessage, type AssistantMessage, type Message, type UserMessage } from "@ag-ui/client";
import { TranscriptList, renderDefaultTool } from "./message-list.tsx";
import { Markdown, type MarkdownProps } from "./markdown.tsx";
import { MessageRow, ReasoningRow } from "./message-row.tsx";
import { transcriptItemKey, transcriptItems, transcriptPageStart, type TranscriptItem } from "./transcript.ts";
import { useChatScroll } from "./use-chat-scroll.ts";

const NEAR_TOP_PX = 96;

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
	/** Reset the transcript view when the conversation changes. */
	threadId?: string;
	/** Maximum number of transcript items per page. Omit to render the full history. */
	historyPageSize?: number;
	className?: string;
	emptyState?: ReactNode;
	labels?: { conversation?: string; working?: string; latest?: string; earlier?: string; reasoning?: string; copy?: string };
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
export function ChatView(props: ChatViewProps) {
	return <ChatThreadView key={props.threadId} {...props} />;
}

function firstItemKey(items: readonly TranscriptItem[], start: number): string | null {
	return start > 0 ? transcriptItemKey(items[start]!) : null;
}

function ChatThreadView({ messages, isRunning, historyPageSize, className, emptyState, labels, slots }: ChatViewProps) {
	const items = useMemo(() => transcriptItems(messages), [messages]);
	const pageSize = Math.max(0, Math.floor(historyPageSize ?? 0));
	const latestStart = pageSize ? transcriptPageStart(items, items.length, pageSize) : 0;
	const [firstKey, setFirstKey] = useState(() => firstItemKey(items, latestStart));
	const firstIndex = firstKey === null ? 0 : items.findIndex((item) => transcriptItemKey(item) === firstKey);
	const start = pageSize ? (firstIndex < 0 ? latestStart : firstIndex) : 0;
	const listRef = useRef<HTMLOListElement>(null);
	const anchor = useRef<{ row: HTMLElement; top: number; focus: boolean } | null>(null);
	const { scroller, scrollerProps, scrollToBottom, restoreReadingPosition, showJumpToLatest } = useChatScroll((element) => {
		if (element.scrollTop <= NEAR_TOP_PX) loadEarlier(element);
	});
	const lastUserId = messages.findLast((message) => message.role === "user")?.id;
	const seenUserId = useRef<string | null>(null);

	function loadEarlier(element: HTMLDivElement, focus = false) {
		if (start === 0 || anchor.current) return;
		const viewportTop = element.getBoundingClientRect().top;
		for (const row of listRef.current?.children ?? []) {
			const bounds = row.getBoundingClientRect();
			if (row instanceof HTMLElement && bounds.height > 0 && bounds.bottom > viewportTop) {
				anchor.current = { row, top: bounds.top - viewportTop + element.scrollTop, focus };
				break;
			}
		}
		setFirstKey(firstItemKey(items, transcriptPageStart(items, start, pageSize)));
	}

	useLayoutEffect(() => {
		const saved = anchor.current;
		anchor.current = null;
		if (!saved || !scroller?.contains(saved.row)) return;
		const top = saved.row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
		restoreReadingPosition(scroller.scrollTop + top - saved.top);
		if (saved.focus) saved.row.focus({ preventScroll: true });
	}, [firstKey, scroller, restoreReadingPosition]);

	useLayoutEffect(() => {
		if (!lastUserId || lastUserId === seenUserId.current) return;
		const isNewUserMessage = seenUserId.current !== null;
		seenUserId.current = lastUserId;
		if (isNewUserMessage) scrollToBottom();
	}, [lastUserId, scrollToBottom]);

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
				{start > 0 && <button type="button" className="agui-chat-earlier" onClick={(event) => {
					if (scroller) loadEarlier(scroller, document.activeElement === event.currentTarget);
				}}>{labels?.earlier ?? "Show earlier messages"}</button>}
				<TranscriptList items={start > 0 ? items.slice(start) : items} label={labels?.conversation} renderItem={renderItem} listRef={listRef} />
				{waiting && <div className="agui-chat-working" data-testid="chat-working" role="status" aria-label={labels?.working ?? "Working…"}><span aria-hidden="true" /></div>}
			</div>
		</div>
		{showJumpToLatest && <button type="button" className="agui-chat-jump" onClick={scrollToBottom}>{labels?.latest ?? "Latest"}</button>}
	</div>;
}
