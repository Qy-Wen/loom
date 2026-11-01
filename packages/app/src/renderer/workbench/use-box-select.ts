import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { boxSelectKeys, emptyTreeSelection, pointerMode, type TreeSelection } from "../library/tree-nav.ts";
import { uiPlatform } from "../../shared/locale.ts";
import { rectBetween, rectsIntersect, type Rect } from "./folder-browser-model.ts";

const DRAG_THRESHOLD = 4;
const EDGE = 28;
const MAX_SCROLL_STEP = 22;

interface Drag {
	pointer: number;
	startX: number;
	startY: number;
	add: boolean;
	base: TreeSelection;
	started: boolean;
	clientX: number;
	clientY: number;
}

/**
 * Rubber-band selection over the tiles inside `contentRef`, each marked with `data-key`.
 * A box replaces the selection, or adds to it with Shift or ⌘/Ctrl. A plain click on empty space clears it.
 * The box lives in content coordinates, so scrolling mid-drag keeps its corners on the same tiles.
 */
export function useBoxSelect({ scrollRef, contentRef, selection, onSelection }: {
	scrollRef: RefObject<HTMLElement | null>;
	contentRef: RefObject<HTMLElement | null>;
	selection: TreeSelection;
	onSelection: (selection: TreeSelection) => void;
}): { box: Rect | null; onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void } {
	const [box, setBox] = useState<Rect | null>(null);
	const drag = useRef<Drag | null>(null);
	const live = useRef({ selection, onSelection });
	live.current = { selection, onSelection };
	const frame = useRef(0);

	const update = useCallback(() => {
		const active = drag.current;
		const content = contentRef.current;
		if (!active || !content) return;
		const origin = content.getBoundingClientRect();
		const rect = rectBetween(active.startX, active.startY, active.clientX - origin.left, active.clientY - origin.top);
		const boxed: string[] = [];
		for (const element of content.querySelectorAll<HTMLElement>("[data-key]")) {
			const tile = element.getBoundingClientRect();
			const local = { x: tile.left - origin.left, y: tile.top - origin.top, width: tile.width, height: tile.height };
			if (rectsIntersect(rect, local)) boxed.push(element.dataset.key!);
		}
		setBox(rect);
		live.current.onSelection(boxSelectKeys(active.base, boxed, active.add));
	}, [contentRef]);

	const stop = useCallback(() => {
		const active = drag.current;
		if (!active) return;
		drag.current = null;
		cancelAnimationFrame(frame.current);
		const scroller = scrollRef.current;
		if (scroller?.hasPointerCapture(active.pointer)) scroller.releasePointerCapture(active.pointer);
		setBox(null);
	}, [scrollRef]);

	// Near the top or bottom edge the view scrolls on its own, so a box can reach tiles that are off screen.
	const tick = useCallback(() => {
		const active = drag.current;
		const scroller = scrollRef.current;
		if (!active?.started || !scroller) return;
		const bounds = scroller.getBoundingClientRect();
		const above = bounds.top + EDGE - active.clientY;
		const below = active.clientY - (bounds.bottom - EDGE);
		const step = above > 0 ? -Math.min(MAX_SCROLL_STEP, above / 2 + 1) : below > 0 ? Math.min(MAX_SCROLL_STEP, below / 2 + 1) : 0;
		if (step !== 0) {
			const before = scroller.scrollTop;
			scroller.scrollTop += step;
			if (scroller.scrollTop !== before) update();
		}
		frame.current = requestAnimationFrame(tick);
	}, [scrollRef, update]);

	useEffect(() => {
		const scroller = scrollRef.current;
		if (!scroller) return;
		const move = (event: PointerEvent) => {
			const active = drag.current;
			if (!active || event.pointerId !== active.pointer) return;
			active.clientX = event.clientX;
			active.clientY = event.clientY;
			if (!active.started) {
				const origin = contentRef.current?.getBoundingClientRect();
				if (!origin) return;
				if (Math.hypot(event.clientX - origin.left - active.startX, event.clientY - origin.top - active.startY) < DRAG_THRESHOLD) return;
				active.started = true;
				scroller.setPointerCapture(active.pointer);
				frame.current = requestAnimationFrame(tick);
			}
			update();
		};
		const up = (event: PointerEvent) => {
			const active = drag.current;
			if (!active || event.pointerId !== active.pointer) return;
			if (!active.started && !active.add) live.current.onSelection(emptyTreeSelection);
			stop();
		};
		scroller.addEventListener("pointermove", move);
		scroller.addEventListener("pointerup", up);
		scroller.addEventListener("pointercancel", stop);
		window.addEventListener("blur", stop);
		return () => {
			scroller.removeEventListener("pointermove", move);
			scroller.removeEventListener("pointerup", up);
			scroller.removeEventListener("pointercancel", stop);
			window.removeEventListener("blur", stop);
			stop();
		};
	}, [scrollRef, contentRef, tick, update, stop]);

	function onPointerDown(event: ReactPointerEvent<HTMLElement>): void {
		const scroller = scrollRef.current;
		const content = contentRef.current;
		if (event.button !== 0 || drag.current || !scroller || !content) return;
		// Tiles, inputs and the scrollbar keep their own behavior.
		if (event.target instanceof Element && event.target.closest("[data-key], input, button")) return;
		const bounds = scroller.getBoundingClientRect();
		if (event.clientX - bounds.left >= scroller.clientWidth) return;
		const origin = content.getBoundingClientRect();
		const mode = pointerMode(event, uiPlatform(navigator.userAgent) === "mac");
		drag.current = {
			pointer: event.pointerId,
			startX: event.clientX - origin.left,
			startY: event.clientY - origin.top,
			add: mode !== "replace",
			base: live.current.selection,
			started: false,
			clientX: event.clientX,
			clientY: event.clientY,
		};
		// A click on empty space moves focus to the browser so its keys work.
		scroller.focus({ preventScroll: true });
	}

	return { box, onPointerDown };
}
