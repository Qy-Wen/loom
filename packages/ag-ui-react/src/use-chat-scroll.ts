import { useCallback, useLayoutEffect, useRef, useState, type TouchEvent, type UIEvent, type WheelEvent } from "react";

const NEAR_BOTTOM_PX = 48;

function distanceFromBottom(element: HTMLElement): number {
	return element.scrollHeight - element.scrollTop - element.clientHeight;
}

function canScroll(element: HTMLElement): boolean {
	return element.scrollHeight > element.clientHeight + 1;
}

/** Follow growing content until the reader scrolls up. Call scrollToBottom to resume following. */
export function useChatScroll() {
	const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
	const pinned = useRef(true);
	const applying = useRef(false);
	const lastTop = useRef(0);
	const touchStartY = useRef<number | null>(null);
	const [away, setAway] = useState(false);
	const [overflowing, setOverflowing] = useState(false);

	const setPinned = useCallback((next: boolean) => {
		pinned.current = next;
		setAway(!next);
	}, []);

	const noteOverflow = useCallback((element: HTMLElement) => {
		const next = canScroll(element);
		setOverflowing(next);
		return next;
	}, []);

	const follow = useCallback(() => {
		if (!scroller) return;
		if (!noteOverflow(scroller)) {
			lastTop.current = scroller.scrollTop;
			setPinned(true);
			return;
		}
		if (!pinned.current) return;
		if (distanceFromBottom(scroller) < 1) {
			lastTop.current = scroller.scrollTop;
			return;
		}
		applying.current = true;
		scroller.scrollTop = scroller.scrollHeight;
		lastTop.current = scroller.scrollTop;
		queueMicrotask(() => {
			applying.current = false;
		});
	}, [scroller, noteOverflow, setPinned]);

	useLayoutEffect(() => {
		if (!scroller) return;
		const observer = new ResizeObserver(follow);
		const watch = () => {
			observer.disconnect();
			observer.observe(scroller);
			for (const child of scroller.children) observer.observe(child);
		};
		watch();
		follow();
		const mutations = new MutationObserver(watch);
		mutations.observe(scroller, { childList: true });
		return () => {
			observer.disconnect();
			mutations.disconnect();
		};
	}, [scroller, follow]);

	const scrollToBottom = useCallback(() => {
		setPinned(true);
		follow();
	}, [follow, setPinned]);

	return {
		scrollerProps: {
			ref: setScroller,
			onWheel(event: WheelEvent<HTMLDivElement>) {
				if (event.deltaY < 0) setPinned(!canScroll(event.currentTarget));
			},
			onTouchStart(event: TouchEvent<HTMLDivElement>) {
				touchStartY.current = event.touches[0]?.clientY ?? null;
			},
			onTouchMove(event: TouchEvent<HTMLDivElement>) {
				const start = touchStartY.current;
				const y = event.touches[0]?.clientY;
				if (start === null || y === undefined) return;
				if (!canScroll(event.currentTarget)) setPinned(true);
				else if (y - start > 8) setPinned(false);
			},
			onScroll(event: UIEvent<HTMLDivElement>) {
				const element = event.currentTarget;
				const top = element.scrollTop;
				const delta = top - lastTop.current;
				lastTop.current = top;
				// A transcript that stops overflowing clamps scrollTop down on its own.
				if (!noteOverflow(element) || distanceFromBottom(element) < 1) setPinned(true);
				else if (!applying.current && event.nativeEvent.isTrusted) {
					if (delta < -1) setPinned(false);
					else if (distanceFromBottom(element) < NEAR_BOTTOM_PX) setPinned(true);
				}
			},
		},
		scrollToBottom,
		showJumpToLatest: away && overflowing,
	};
}
