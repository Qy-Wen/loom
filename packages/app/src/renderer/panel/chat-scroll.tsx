import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { CopilotChat } from "@copilotkit/react-core/v2";
import { useLocale } from "../locale.tsx";
import { ChatViewContext, useChatSession } from "./chat-context.ts";

const NEAR_BOTTOM_PX = 48;

function distanceFromBottom(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function canScroll(el: HTMLElement): boolean {
	return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Follow new output only while the reader is already at the bottom.
 * A scroll we caused does not count as leaving. Neither does the transcript
 * shrinking until it no longer scrolls: opening another session reuses this
 * view, and the browser clamps scrollTop downward. Scrolling up does, until
 * the reader returns to the bottom or opens another session.
 */
export function SessionScrollView({
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
	const { t } = useLocale();
	const { threadId } = useChatSession();
	const { messages: visible } = useContext(ChatViewContext);
	const scrollerRef = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const applying = useRef(false);
	const lastTop = useRef(0);
	const touchStartY = useRef<number | null>(null);
	const [away, setAway] = useState(false);
	const [overflowing, setOverflowing] = useState(false);

	const setPinned = useCallback((next: boolean) => {
		pinned.current = next;
		setAway((current) => current === !next ? current : !next);
	}, []);

	const noteOverflow = useCallback((el: HTMLElement) => {
		const next = canScroll(el);
		setOverflowing((current) => current === next ? current : next);
		return next;
	}, []);

	const follow = useCallback(() => {
		const el = scrollerRef.current;
		if (!el) return;
		if (!noteOverflow(el)) {
			lastTop.current = el.scrollTop;
			setPinned(true);
			return;
		}
		if (!pinned.current) return;
		const top = el.scrollHeight;
		if (distanceFromBottom(el) < 1) {
			lastTop.current = el.scrollTop;
			return;
		}
		applying.current = true;
		el.scrollTop = top;
		lastTop.current = el.scrollTop;
		queueMicrotask(() => {
			applying.current = false;
		});
	}, [noteOverflow, setPinned]);

	useLayoutEffect(() => {
		const el = scrollerRef.current;
		if (!el) return;
		const observer = new ResizeObserver(() => follow());
		const watch = () => {
			observer.disconnect();
			const content = el.firstElementChild;
			if (content) observer.observe(content);
		};
		watch();
		follow();
		const mutations = new MutationObserver(watch);
		mutations.observe(el, { childList: true });
		return () => {
			observer.disconnect();
			mutations.disconnect();
		};
	}, [follow]);

	let lastUserId = "";
	for (let index = visible.length - 1; index >= 0; index--) {
		const message = visible[index];
		if (message?.role === "user") {
			lastUserId = message.id;
			break;
		}
	}
	const seenUserId = useRef<string | null>(null);
	useLayoutEffect(() => {
		if (!lastUserId) return;
		if (seenUserId.current === null) {
			seenUserId.current = lastUserId;
			return;
		}
		if (seenUserId.current === lastUserId) return;
		seenUserId.current = lastUserId;
		setPinned(true);
		follow();
	}, [follow, lastUserId, setPinned]);

	useLayoutEffect(() => {
		setPinned(true);
		follow();
	}, [follow, setPinned, threadId]);

	return (
		<div className="session-chat-scroll-host">
			<div
				{...props}
				ref={scrollerRef}
				className={`session-chat-scroll${className ? ` ${className}` : ""}`}
				onWheel={(event) => {
					const el = scrollerRef.current;
					if (!el || event.deltaY >= 0) return;
					if (!canScroll(el)) {
						setPinned(true);
						return;
					}
					setPinned(false);
				}}
				onTouchStart={(event) => {
					touchStartY.current = event.touches[0]?.clientY ?? null;
				}}
				onTouchMove={(event) => {
					const el = scrollerRef.current;
					const start = touchStartY.current;
					const y = event.touches[0]?.clientY;
					if (!el || start === null || y === undefined) return;
					if (!canScroll(el)) {
						setPinned(true);
						return;
					}
					if (y - start > 8) setPinned(false);
				}}
				onScroll={(event) => {
					const el = event.currentTarget;
					const top = el.scrollTop;
					const delta = top - lastTop.current;
					lastTop.current = top;
					// A shrinking transcript clamps scrollTop down. That delta is
					// negative even though the reader is still at the bottom.
					if (!noteOverflow(el) || distanceFromBottom(el) < 1) setPinned(true);
					else if (!applying.current && event.nativeEvent.isTrusted) {
						if (delta < -1) setPinned(false);
						else if (distanceFromBottom(el) < NEAR_BOTTOM_PX) setPinned(true);
					}
					onScroll?.(event);
				}}
			>
				{children}
			</div>
			{away && overflowing ? (
				<button
					type="button"
					className="session-chat-jump"
					onClick={() => {
						setPinned(true);
						follow();
					}}
				>
					{t.chat.latest}
				</button>
			) : null}
		</div>
	);
}
