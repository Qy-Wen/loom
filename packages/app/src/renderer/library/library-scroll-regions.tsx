import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { DEFAULT_SHORTCUT_FRACTION, libraryRegionSize } from "./library-region-size.ts";

const STORAGE_KEY = "loom.library.shortcutFraction";

function ScrollArea({ className = "", scrollRef, ...props }: HTMLAttributes<HTMLDivElement> & { scrollRef?: Ref<HTMLDivElement> }): React.JSX.Element {
	return <div {...props} ref={scrollRef} className={`library-scroll thin-scroll ${className}`} />;
}

/** Favorites/tags and the file tree scroll independently; the upper pane shrinks to its contents. */
export function LibraryScrollRegions({ shortcuts, filesHeader, children, label, moreHint, filesProps }: {
	shortcuts: ReactNode | null; filesHeader: ReactNode; children: ReactNode; label: string; moreHint: string;
	filesProps: Pick<HTMLAttributes<HTMLDivElement>, "onDragOver" | "onDrop" | "onContextMenu">;
}): React.JSX.Element {
	const root = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const header = useRef<HTMLDivElement>(null);
	const shortcutsScroll = useRef<HTMLDivElement>(null);
	const handle = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointer: number; origin: number; size: number } | null>(null);
	const paneId = useId();
	const [fraction, setFraction] = useState(() => {
		try {
			const value = Number(localStorage.getItem(STORAGE_KEY));
			if (Number.isFinite(value) && value > 0 && value <= 1) return value;
		} catch { /* Layout storage is optional. */ }
		return DEFAULT_SHORTCUT_FRACTION;
	});
	const [height, setHeight] = useState(0);
	const [contentHeight, setContentHeight] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [moreBelow, setMoreBelow] = useState(false);
	const hasShortcuts = shortcuts !== null;
	const layout = libraryRegionSize(height, contentHeight, fraction);
	// Folded shortcuts leave min === max: there is nothing to drag, so the divider stops offering it.
	const adjustable = layout.max - layout.min >= 1;
	const updateMoreBelow = () => {
		const element = shortcutsScroll.current;
		setMoreBelow(!!element && element.clientHeight > 0 && element.scrollHeight - element.clientHeight - element.scrollTop > 1);
	};
	useLayoutEffect(updateMoreBelow, [hasShortcuts, layout.size, contentHeight]);
	// Reserve the fixed file heading/search before sizing the two scrollports.
	const availableHeight = () => Math.max(0, (root.current?.getBoundingClientRect().height ?? 0) - (header.current?.getBoundingClientRect().height ?? 0));
	const measure = () => {
		const size = availableHeight();
		if (size > 0) setHeight(size); // Keep the last measurement while the sidebar is hidden.
		setContentHeight(content.current?.getBoundingClientRect().height ?? 0);
	};
	useLayoutEffect(() => {
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root.current!);
		if (header.current) observer.observe(header.current);
		if (content.current) observer.observe(content.current);
		return () => observer.disconnect();
	}, [hasShortcuts]);
	useEffect(() => {
		try { localStorage.setItem(STORAGE_KEY, String(fraction)); } catch { /* Layout storage is optional. */ }
	}, [fraction]);
	const current = () => libraryRegionSize(availableHeight() || height, content.current?.getBoundingClientRect().height ?? contentHeight, fraction);
	const resize = (pixels: number) => {
		const limits = current();
		if (limits.extent <= 0) return;
		setFraction(Math.min(limits.max, Math.max(limits.min, pixels)) / limits.extent);
	};
	const endDrag = useCallback(() => {
		const active = drag.current;
		if (!active) return;
		drag.current = null;
		if (handle.current?.hasPointerCapture(active.pointer)) handle.current.releasePointerCapture(active.pointer);
		document.body.classList.remove("library-resizing-regions");
		setDragging(false);
	}, []);
	useEffect(() => {
		window.addEventListener("blur", endDrag);
		return () => { window.removeEventListener("blur", endDrag); endDrag(); };
	}, [endDrag]);
	useEffect(() => { if (!hasShortcuts || !adjustable) endDrag(); }, [hasShortcuts, adjustable, endDrag]);
	return <div ref={root} className="library-scroll-regions">
		{hasShortcuts ? <>
			<div className="library-shortcuts-pane" style={{ height: layout.size }}>
				<ScrollArea id={paneId} scrollRef={shortcutsScroll} className="library-shortcuts" onScroll={updateMoreBelow}>
					<div ref={content} className="library-shortcuts-content">{shortcuts}</div>
				</ScrollArea>
				{moreBelow ? <div className="library-shortcuts-more" aria-hidden="true" /> : null}
			</div>
			<div ref={handle} className={`library-region-handle${moreBelow ? " has-more" : ""}${dragging ? " is-dragging" : ""}${adjustable ? "" : " is-fixed"}`} role="separator" tabIndex={adjustable ? 0 : undefined} aria-disabled={adjustable ? undefined : true}
				aria-label={label} aria-orientation="horizontal" aria-controls={paneId} aria-description={moreBelow ? moreHint : undefined} title={moreBelow ? moreHint : label}
				aria-valuemin={Math.round(layout.min)} aria-valuemax={Math.round(layout.max)} aria-valuenow={Math.round(layout.size)}
				onDoubleClick={() => setFraction(DEFAULT_SHORTCUT_FRACTION)}
				onKeyDown={(event) => {
					if (!adjustable || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
					event.preventDefault(); event.stopPropagation();
					const limits = current();
					resize(event.key === "Home" ? limits.min : event.key === "End" ? limits.max : limits.size + (event.key === "ArrowUp" ? -10 : 10));
				}}
				onPointerDown={(event) => {
					if (!adjustable || event.button !== 0 || drag.current) return;
					event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
					drag.current = { pointer: event.pointerId, origin: event.clientY, size: current().size };
					document.body.classList.add("library-resizing-regions"); setDragging(true);
				}}
				onPointerMove={(event) => {
					const active = drag.current;
					if (active?.pointer === event.pointerId) resize(active.size + event.clientY - active.origin);
				}}
				onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
			/>
		</> : null}
		<div className="library-files-pane">
			<div ref={header} className="library-files-header">{filesHeader}</div>
			<ScrollArea className="asset-list" {...filesProps}>{children}</ScrollArea>
		</div>
	</div>;
}
