import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { readSplitSize, splitBounds, splitSize, TRACE_SPLIT_HANDLE } from "./split-size.ts";

type Props = {
	label: string;
	storageKey: string;
	defaultSize: number;
	unit?: "px" | "fraction";
	minFirst: number;
	minSecond: number;
	children: readonly [ReactNode, ReactNode];
};

/** Development-view layout only; preferences survive trace selection, tab changes, and window reopen. */
export function TraceSplit({ label, storageKey, defaultSize, unit = "px", minFirst, minSecond, children }: Props): React.JSX.Element {
	const root = useRef<HTMLDivElement>(null);
	const handle = useRef<HTMLDivElement>(null);
	const drag = useRef<{ pointer: number; origin: number; size: number } | null>(null);
	const paneId = useId();
	const [preferred, setPreferred] = useState(() => {
		try { return readSplitSize(localStorage, storageKey, defaultSize); } catch { return defaultSize; }
	});
	const [extent, setExtent] = useState(0);
	const [dragging, setDragging] = useState(false);
	const bodyClass = "trace-resizing-columns";
	const first = splitSize(unit === "fraction" ? preferred * extent : preferred, extent, minFirst, minSecond);
	const bounds = splitBounds(extent, minFirst, minSecond);
	const currentExtent = () => {
		const element = root.current;
		return element ? Math.max(0, element.clientWidth - TRACE_SPLIT_HANDLE) : extent;
	};
	const resize = (pixels: number) => {
		// Another divider may just have changed our available room before ResizeObserver delivered it.
		const available = currentExtent();
		if (available <= 0) return;
		const size = splitSize(pixels, available, minFirst, minSecond);
		setExtent(available);
		setPreferred(unit === "fraction" ? size / available : size);
	};

	useLayoutEffect(() => {
		const element = root.current!;
		const measure = () => {
			const size = element.clientWidth;
			// A hidden tab has no layout box. Keep its last measured size to avoid a restore cascade.
			if (size > 0) setExtent(Math.max(0, size - TRACE_SPLIT_HANDLE));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		try { localStorage.setItem(storageKey, String(preferred)); } catch { /* Layout storage must not break diagnostics. */ }
	}, [preferred, storageKey]);

	const endDrag = useCallback(() => {
		const active = drag.current;
		if (!active) return;
		drag.current = null;
		if (handle.current?.hasPointerCapture(active.pointer)) handle.current.releasePointerCapture(active.pointer);
		document.body.classList.remove(bodyClass);
		setDragging(false);
	}, [bodyClass]);
	useEffect(() => {
		window.addEventListener("blur", endDrag);
		return () => { window.removeEventListener("blur", endDrag); endDrag(); };
	}, [endDrag]);

	return (
		<div ref={root} className="trace-split">
			<div id={paneId} className="trace-split-pane" style={{ flex: `0 0 ${first}px` }}>{children[0]}</div>
			<div
				ref={handle}
				className={`trace-split-handle${dragging ? " is-dragging" : ""}`}
				role="separator"
				tabIndex={0}
				aria-label={label}
				aria-controls={paneId}
				aria-orientation="vertical"
				aria-valuemin={Math.round(bounds.min)}
				aria-valuemax={Math.round(bounds.max)}
				aria-valuenow={Math.round(first)}
				aria-valuetext={`${Math.round(first)} pixels`}
				title={`${label} · Drag to resize, double-click to reset`}
				onDoubleClick={() => setPreferred(defaultSize)}
				onKeyDown={(event) => {
					if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					const available = currentExtent(), limits = splitBounds(available, minFirst, minSecond);
					const size = splitSize(unit === "fraction" ? preferred * available : preferred, available, minFirst, minSecond);
					resize(event.key === "Home" ? limits.min : event.key === "End" ? limits.max : size + (event.key === "ArrowLeft" ? -10 : 10));
				}}
				onPointerDown={(event) => {
					if (event.button !== 0 || drag.current) return;
					event.preventDefault();
					event.currentTarget.focus();
					event.currentTarget.setPointerCapture(event.pointerId);
					const available = currentExtent();
					drag.current = { pointer: event.pointerId, origin: event.clientX, size: splitSize(unit === "fraction" ? preferred * available : preferred, available, minFirst, minSecond) };
					document.body.classList.add(bodyClass);
					setDragging(true);
				}}
				onPointerMove={(event) => {
					const active = drag.current;
					if (!active || active.pointer !== event.pointerId) return;
					resize(active.size + event.clientX - active.origin);
				}}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onLostPointerCapture={endDrag}
			/>
			<div className="trace-split-pane trace-split-rest">{children[1]}</div>
		</div>
	);
}
