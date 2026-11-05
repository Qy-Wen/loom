import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./tooltip.css";

export const TOOLTIP_SHOW_DELAY_MS = 150;
export const TOOLTIP_LEAVE_DELAY_MS = 80;

interface TooltipOptions { immediate?: boolean; interactive?: boolean; className?: string; }
interface TooltipEntry extends TooltipOptions { anchor: Element; content: ReactNode; }
interface TooltipController {
	anchor: Element | null;
	show(anchor: Element, content: ReactNode, options?: TooltipOptions): void;
	dismiss(): void;
	leave(): void;
	keep(): void;
	contains(target: EventTarget | null): boolean;
}
const TooltipContext = createContext<TooltipController | null>(null);
export function useTooltip(): TooltipController {
	const value = useContext(TooltipContext);
	if (!value) throw new Error("TooltipProvider is required");
	return value;
}

/** One tooltip per window, shared by text hints, controls, and interactive error details. */
export function TooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
	const id = useId();
	const [entry, setEntry] = useState<TooltipEntry | null>(null);
	const pending = useRef<TooltipEntry | null>(null);
	const popup = useRef<HTMLDivElement>(null);
	const showTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const keep = useCallback(() => clearTimeout(hideTimer.current), []);
	const dismiss = useCallback(() => {
		clearTimeout(showTimer.current); clearTimeout(hideTimer.current);
		pending.current = null; setEntry(null);
	}, []);
	const leave = useCallback(() => {
		clearTimeout(showTimer.current); clearTimeout(hideTimer.current);
		hideTimer.current = setTimeout(dismiss, TOOLTIP_LEAVE_DELAY_MS);
	}, [dismiss]);
	const show = useCallback((anchor: Element, content: ReactNode, options: TooltipOptions = {}) => {
		clearTimeout(hideTimer.current);
		if (pending.current?.anchor === anchor && popup.current && !options.immediate) return;
		clearTimeout(showTimer.current);
		const next = { anchor, content, ...options };
		pending.current = next;
		setEntry(null);
		if (options.immediate) setEntry(next);
		else showTimer.current = setTimeout(() => {
			if (!anchor.isConnected) { dismiss(); return; }
			if (typeof content === "string") next.content = anchor.getAttribute("data-tooltip") ?? anchor.getAttribute("aria-label") ?? content;
			setEntry(next);
		}, TOOLTIP_SHOW_DELAY_MS);
	}, [dismiss]);
	const contains = useCallback((target: EventTarget | null) => target instanceof Node && Boolean(popup.current?.contains(target)), []);
	const controller = useMemo(() => ({ anchor: entry?.anchor ?? null, show, dismiss, leave, keep, contains }), [entry, show, dismiss, leave, keep, contains]);
	useEffect(() => () => { clearTimeout(showTimer.current); clearTimeout(hideTimer.current); }, []);
	useEffect(() => {
		const find = (target: EventTarget | null): Element | null => {
			if (!(target instanceof Element) || target.closest("[data-tooltip-custom], [role=tooltip]")) return null;
			return target.closest("[data-tooltip]");
		};
		const enter = (event: PointerEvent | FocusEvent) => {
			if (event instanceof PointerEvent && (event.pointerType === "touch" || event.buttons)) return;
			const anchor = find(event.target);
			if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return;
			if (anchor.matches(":disabled, [aria-disabled=true]")) return;
			const content = anchor.getAttribute("data-tooltip") ?? anchor.getAttribute("aria-label");
			if (content) show(anchor, content, { immediate: event.type === "focusin" });
		};
		const exit = (event: PointerEvent | FocusEvent) => {
			const anchor = find(event.target);
			if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return;
			if (event.type === "focusout") dismiss(); else leave();
		};
		const click = (event: Event) => { if (!contains(event.target)) dismiss(); };
		const key = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
		document.addEventListener("pointerover", enter, true); document.addEventListener("pointerout", exit, true);
		document.addEventListener("focusin", enter, true); document.addEventListener("focusout", exit, true);
		document.addEventListener("pointerdown", click, true); document.addEventListener("click", click, true);
		document.addEventListener("keydown", key, true);
		return () => {
			document.removeEventListener("pointerover", enter, true); document.removeEventListener("pointerout", exit, true);
			document.removeEventListener("focusin", enter, true); document.removeEventListener("focusout", exit, true);
			document.removeEventListener("pointerdown", click, true); document.removeEventListener("click", click, true);
			document.removeEventListener("keydown", key, true);
		};
	}, [show, dismiss, leave, contains]);
	useLayoutEffect(() => {
		if (!entry) return;
		const previous = entry.anchor.getAttribute("aria-describedby");
		entry.anchor.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
		const observer = new MutationObserver(() => {
			if (!entry.anchor.isConnected || entry.anchor.matches(":disabled, [aria-disabled=true], [hidden]")) { dismiss(); return; }
			const content = entry.anchor.getAttribute("data-tooltip") ?? entry.anchor.getAttribute("aria-label");
			if (typeof entry.content === "string" && content !== null && content !== entry.content) {
				setEntry((current) => current?.anchor === entry.anchor ? { ...current, content } : current);
			}
		});
		observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tooltip", "aria-label", "disabled", "aria-disabled", "hidden"] });
		return () => {
			observer.disconnect();
			if (previous === null) entry.anchor.removeAttribute("aria-describedby");
			else entry.anchor.setAttribute("aria-describedby", previous);
		};
	}, [entry, id, dismiss]);
	return <TooltipContext.Provider value={controller}>
		{children}
		{entry && <TooltipPopup id={id} entry={entry} popup={popup} controller={controller} />}
	</TooltipContext.Provider>;
}

function TooltipPopup({ id, entry, popup, controller }: {
	id: string; entry: TooltipEntry; popup: React.RefObject<HTMLDivElement | null>; controller: TooltipController;
}): React.JSX.Element {
	const [position, setPosition] = useState({ left: 0, top: 0 });
	useLayoutEffect(() => {
		const place = () => {
			if (!popup.current || !entry.anchor.isConnected) return;
			const bounds = entry.anchor.getBoundingClientRect(), tip = popup.current.getBoundingClientRect();
			const left = Math.max(8, Math.min(bounds.left + bounds.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8));
			const top = bounds.bottom + tip.height + 8 <= window.innerHeight ? bounds.bottom + 8 : Math.max(8, bounds.top - tip.height - 8);
			setPosition({ left, top });
		};
		place();
		const observer = new ResizeObserver(place); observer.observe(entry.anchor); observer.observe(popup.current!);
		window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
		return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
	}, [entry, popup]);
	return createPortal(<div ref={popup} id={id} role="tooltip"
		className={`tooltip${entry.interactive ? " tooltip-interactive" : ""}${entry.className ? ` ${entry.className}` : ""}`}
		style={position} onPointerEnter={controller.keep} onPointerLeave={controller.leave}
		onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !entry.anchor.contains(event.relatedTarget)) controller.leave(); }}
	>{entry.content}</div>, document.body);
}
