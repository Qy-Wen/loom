import { useChatScroll } from "@loom/ag-ui-react";
import { useContext, useLayoutEffect, useRef } from "react";
import { useLocale } from "../locale.tsx";
import { ChatViewContext, useChatSession } from "./chat-context.ts";
import { ChatEmptyState } from "./chat-empty.tsx";

export function SessionScrollView({ children }: { children: React.ReactNode }): React.JSX.Element {
	const { t } = useLocale();
	const { threadId } = useChatSession();
	const { messages: visible } = useContext(ChatViewContext);
	const { scrollerProps, scrollToBottom, showJumpToLatest } = useChatScroll();

	const lastUserId = visible.findLast((message) => message.role === "user")?.id;
	const seenUserId = useRef<string | null>(null);

	useLayoutEffect(() => {
		if (!lastUserId || seenUserId.current === lastUserId) return;
		const isNewUserMessage = seenUserId.current !== null;
		seenUserId.current = lastUserId;
		if (isNewUserMessage) scrollToBottom();
	}, [lastUserId, scrollToBottom]);

	useLayoutEffect(() => {
		scrollToBottom();
	}, [scrollToBottom, threadId]);

	return (
		<div className="session-chat-scroll-host">
			<div className="session-chat-scroll thin-scroll" {...scrollerProps}>
				{visible.length === 0 && <ChatEmptyState />}
				{children}
			</div>
			{showJumpToLatest ? (
				<button type="button" className="session-chat-jump" onClick={scrollToBottom}>
					{t.chat.latest}
				</button>
			) : null}
		</div>
	);
}
