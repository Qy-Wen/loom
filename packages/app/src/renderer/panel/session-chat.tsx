import type { Message } from "@ag-ui/core";
import {
	CopilotChat,
	CopilotChatAssistantMessage,
	CopilotChatInput,
	CopilotChatMessageView,
	type CopilotChatAssistantMessageProps,
	type CopilotChatInputProps,
	type CopilotChatMessageViewProps,
	type CopilotChatViewProps,
} from "@copilotkit/react-core/v2";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HarnessContextUsage, LoomTranscriptMessage } from "@loom/agent";
import { mergeChatMessages, toAgUiMessages } from "../../shared/ag-ui-messages.ts";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";

const StoredMessagesContext = createContext<Message[]>([]);
const VisibleMessagesContext = createContext<Message[]>([]);
const ThreadIdContext = createContext("");

type QueuedFollowUp = { text: string; seen: number };

/**
 * Drop one queued line per new user message with the same text.
 * Survivors remember the current count, so the next render does not spend that message again.
 */
function reconcileQueued(items: QueuedFollowUp[], messages: readonly Message[]): QueuedFollowUp[] {
	if (items.length === 0) return items;
	const counts = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "user" || typeof message.content !== "string") continue;
		counts.set(message.content, (counts.get(message.content) ?? 0) + 1);
	}
	const removed = new Map<string, number>();
	const next: QueuedFollowUp[] = [];
	let changed = false;
	for (const item of items) {
		const total = counts.get(item.text) ?? 0;
		const arrived = total - item.seen - (removed.get(item.text) ?? 0);
		if (arrived > 0) {
			removed.set(item.text, (removed.get(item.text) ?? 0) + 1);
			changed = true;
			continue;
		}
		const seen = Math.max(item.seen, total);
		if (seen === item.seen) next.push(item);
		else {
			next.push({ text: item.text, seen });
			changed = true;
		}
	}
	return changed ? next : items;
}

/**
 * Instant snap-to-bottom on mount. CopilotChat's default ScrollView first paints
 * at the top, then animates down (visible when switching sessions).
 */
function SessionScrollView({
	children,
	className,
	autoScroll: _autoScroll,
	scrollToBottomButton: _scrollToBottomButton,
	feather: _feather,
	inputContainerHeight: _inputContainerHeight,
	isResizing: _isResizing,
	onScroll,
	...props
}: React.ComponentProps<typeof CopilotChat.View.ScrollView>): React.JSX.Element {
	const ref = useRef<HTMLDivElement>(null);
	const stick = useRef(true);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const snap = () => {
			if (stick.current) el.scrollTop = el.scrollHeight;
		};
		snap();
		const observer = new ResizeObserver(snap);
		observer.observe(el);
		if (el.firstElementChild) observer.observe(el.firstElementChild);
		return () => observer.disconnect();
	}, []);

	return (
		<div
			{...props}
			ref={ref}
			className={`session-chat-scroll${className ? ` ${className}` : ""}`}
			onScroll={(event) => {
				const el = event.currentTarget;
				stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				onScroll?.(event);
			}}
		>
			{children}
		</div>
	);
}

const SessionAssistantMessage = ((props: CopilotChatAssistantMessageProps) => {
	if (isChatErrorMessageId(props.message.id)) {
		const text = typeof props.message.content === "string" ? props.message.content : "";
		return (
			<div className="chat-error" role="alert">
				<div className="chat-error-label">Request failed</div>
				<p className="chat-error-body">{text}</p>
			</div>
		);
	}
	return <CopilotChatAssistantMessage {...props} />;
}) as typeof CopilotChatAssistantMessage;

const SessionMessageView = ((props: CopilotChatMessageViewProps) => {
	return <CopilotChatMessageView {...props} assistantMessage={SessionAssistantMessage} />;
}) as typeof CopilotChatMessageView;

/** Enter while a run is active queues a follow-up. Empty input keeps Stop; text restores Send. */
const FollowUpInput = (({ onSubmitMessage, isRunning, onChange, value, ...props }: CopilotChatInputProps) => {
	const threadId = useContext(ThreadIdContext);
	const visible = useContext(VisibleMessagesContext);
	const [queued, setQueued] = useState<QueuedFollowUp[]>([]);
	const hasDraft = (value ?? "").trim().length > 0;
	useEffect(() => {
		if (!isRunning) {
			setQueued([]);
			return;
		}
		setQueued((items) => reconcileQueued(items, visible));
	}, [isRunning, visible]);
	return (
		<div className="session-follow-up-slot">
			{queued.length > 0 && (
				<section className="session-follow-up" aria-label="Queued">
					<div className="session-follow-up-label">Queued</div>
					<ol>
						{queued.map((item, index) => (
							<li key={`${index}:${item.text}`}>{item.text}</li>
						))}
					</ol>
				</section>
			)}
			<CopilotChatInput
				{...props}
				value={value}
				isRunning={Boolean(isRunning) && !hasDraft}
				showDisclaimer={false}
				onChange={onChange}
				onSubmitMessage={(submitted) => {
					if (!isRunning || !threadId) {
						onSubmitMessage?.(submitted);
						return;
					}
					const seen = visible.filter((message) => message.role === "user" && message.content === submitted).length;
					void window.loom.followUp(threadId, submitted).then(
						() => setQueued((items) => [...items, { text: submitted, seen }]),
						() => onChange?.(submitted),
					);
				}}
			/>
		</div>
	);
}) as typeof CopilotChatInput;

/** Stable slot so CopilotChat does not remount the view on every parent render. */
function SessionChatView(props: CopilotChatViewProps): React.JSX.Element {
	const stored = useContext(StoredMessagesContext);
	const messages = useMemo(
		() => mergeChatMessages(stored, props.messages ?? []),
		[stored, props.messages],
	);
	return (
		<VisibleMessagesContext.Provider value={messages}>
			<CopilotChat.View
				{...props}
				messages={messages}
				scrollView={SessionScrollView}
				messageView={SessionMessageView}
				input={FollowUpInput}
			/>
		</VisibleMessagesContext.Provider>
	);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/** Context usage indicator, e.g. 12.5%/1.0M; "?" after compaction until the next response. */
function ContextIndicator({ context }: { context: HarnessContextUsage | null }): React.JSX.Element | null {
	if (!context) return null;
	const percent = context.percent !== null ? `${context.percent.toFixed(1)}%` : "?";
	return (
		<div className="session-context-usage" title="Share of the model context window in use">
			{percent}/{formatTokens(context.window)}
		</div>
	);
}

/** Draw JSONL history through CopilotChat.View without writing into its agent. */
export function SessionChat({
	threadId,
	messages,
	context,
}: {
	threadId: string;
	messages: LoomTranscriptMessage[];
	context: HarnessContextUsage | null;
}): React.JSX.Element {
	const stored = useMemo(() => toAgUiMessages(messages), [messages]);

	return (
		<StoredMessagesContext.Provider value={stored}>
			<ThreadIdContext.Provider value={threadId}>
			<div className="session-chat-shell">
				<CopilotChat key={threadId} threadId={threadId} chatView={SessionChatView} />
				<ContextIndicator context={context} />
			</div>
			</ThreadIdContext.Provider>
		</StoredMessagesContext.Provider>
	);
}
