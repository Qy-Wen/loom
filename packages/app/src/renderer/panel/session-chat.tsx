import type { Message } from "@ag-ui/core";
import {
	CopilotChat,
	CopilotChatAssistantMessage,
	CopilotChatMessageView,
	type CopilotChatAssistantMessageProps,
	type CopilotChatMessageViewProps,
	type CopilotChatViewProps,
} from "@copilotkit/react-core/v2";
import { createContext, useContext, useLayoutEffect, useMemo, useRef } from "react";
import type { LoomTranscriptMessage } from "@loom/core";
import { mergeChatMessages, toAgUiMessages } from "../../shared/ag-ui-messages.ts";
import { isChatErrorMessageId } from "../../shared/chat-error.ts";

const StoredMessagesContext = createContext<Message[]>([]);

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

/** Stable slot so CopilotChat does not remount the view on every parent render. */
function SessionChatView(props: CopilotChatViewProps): React.JSX.Element {
	const stored = useContext(StoredMessagesContext);
	const messages = useMemo(
		() => mergeChatMessages(stored, props.messages ?? []),
		[stored, props.messages],
	);
	return (
		<CopilotChat.View
			{...props}
			messages={messages}
			scrollView={SessionScrollView}
			messageView={SessionMessageView}
		/>
	);
}

/** Draw JSONL history through CopilotChat.View without writing into its agent. */
export function SessionChat({
	threadId,
	messages,
}: {
	threadId: string;
	messages: LoomTranscriptMessage[];
}): React.JSX.Element {
	const stored = useMemo(() => toAgUiMessages(messages), [messages]);

	return (
		<StoredMessagesContext.Provider value={stored}>
			<CopilotChat key={threadId} threadId={threadId} chatView={SessionChatView} />
		</StoredMessagesContext.Provider>
	);
}
