import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { eventLabels } from "./trace-events.ts";
import { timelineGapLabel, type TimelineLayout } from "./trace-timeline-layout.ts";
import { formatTraceDuration } from "./trace-spans.ts";

export type FocusRange = { start: number; end: number } | null;
export function TraceTimeline({ layout, onWidthChange, now, selected, range, setRange, select }: {
	layout: TimelineLayout; onWidthChange(width: number): void; now: number; selected: string | null; range: FocusRange;
	setRange(range: FocusRange): void; select(id: string): void;
}): React.JSX.Element {
	const { blocks, gaps } = layout;
	const track = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const measure = () => onWidthChange(track.current!.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure); observer.observe(track.current!);
		return () => observer.disconnect();
	}, [onWidthChange]);
	const drag = useRef<{ pointer: number; start: number; x: number; moved: boolean } | null>(null);
	const tooltipId = useId();
	const [hovered, setHovered] = useState<{ id: string; anchor: HTMLButtonElement; keyboard: boolean } | null>(null);
	const [visibleTooltip, setVisibleTooltip] = useState<string | null>(null);
	useEffect(() => {
		setVisibleTooltip(null);
		if (!hovered) return;
		const timer = setTimeout(() => setVisibleTooltip(hovered.id), hovered.keyboard ? 0 : 150);
		return () => clearTimeout(timer);
	}, [hovered]);
	const tooltipVisible = hovered !== null && visibleTooltip === hovered.id;
	const tooltipBlock = blocks.find((block) => block.event.id === hovered?.id);
	const tooltipGap = gaps.find((gap) => gap.id === hovered?.id);
	const tooltipText = tooltipBlock ? `${tooltipBlock.event.label} · ${tooltipBlock.event.marker ? "请求快照，无独立耗时" : formatTraceDuration(Math.max(0, (tooltipBlock.event.span.endedMs ?? now) - tooltipBlock.event.span.startedMs))}${tooltipBlock.firstChunk === undefined ? "" : ` · 首 chunk ${formatTraceDuration(tooltipBlock.event.span.events.find((row) => row.name === "pi.ai.first_chunk")!.timeMs)}`}` : tooltipGap ? timelineGapLabel(tooltipGap) : undefined;
	const tooltipHandlers = (id: string): ButtonHTMLAttributes<HTMLButtonElement> => ({
		"aria-describedby": tooltipVisible && hovered?.id === id ? tooltipId : undefined,
		onPointerEnter: (event) => { if (!drag.current && event.pointerType !== "touch") setHovered({ id, anchor: event.currentTarget, keyboard: false }); },
		onPointerLeave: () => setHovered((old) => old?.id === id ? null : old),
		onFocus: (event) => setHovered({ id, anchor: event.currentTarget, keyboard: true }),
		onBlur: () => setHovered((old) => old?.id === id ? null : old),
	});
	const fraction = (x: number, element: HTMLElement) => { const bounds = element.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - bounds.left) / Math.max(1, bounds.width))); };
	return <section className="trace-overview" aria-label="轨迹时间线">
		<div className="trace-lane-labels" aria-hidden="true"><span>输入</span><span>模型</span><span>工具</span></div>
		<div ref={track} className="trace-overview-track" tabIndex={0} aria-label="时间线概览，拖动聚焦事件，Escape 清除范围" onKeyDown={(event) => { if (event.key === "Escape") { setRange(null); setHovered(null); } }}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				setHovered(null);
				event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
				drag.current = { pointer: event.pointerId, start: fraction(event.clientX, event.currentTarget), x: event.clientX, moved: false };
			}}
			onPointerMove={(event) => {
				const active = drag.current; if (!active || active.pointer !== event.pointerId) return;
				if (Math.abs(active.x - event.clientX) < 3 && !active.moved) return;
				active.moved = true; const end = fraction(event.clientX, event.currentTarget);
				setRange({ start: Math.min(active.start, end), end: Math.max(active.start, end) });
			}}
			onPointerUp={(event) => {
				const active = drag.current; drag.current = null;
				if (active && !active.moved) {
					// Hit-test the painted blocks, including their minimum-width footprint and overlap order.
					const element = document.elementFromPoint(event.clientX, event.clientY);
					const target = element?.closest<HTMLButtonElement>(".trace-overview-block");
					const hit = target && event.currentTarget.contains(target) ? blocks.find((block) => block.event.id === target.dataset.eventId) : undefined;
					const point = fraction(event.clientX, event.currentTarget);
					const lane = Math.max(0, Math.min(2, Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top - 6) / 14)));
					const candidates = blocks.filter((block) => block.lane === lane);
					const contained = candidates.filter((block) => point >= block.paintedLeft && point <= block.paintedLeft + block.paintedWidth);
					const nearest = (contained.length ? contained : candidates).sort((a, b) => Math.abs(a.paintedLeft + a.paintedWidth / 2 - point) - Math.abs(b.paintedLeft + b.paintedWidth / 2 - point))[0];
					const chosen = element?.closest(".trace-overview-gap") ? undefined : hit ?? nearest;
					if (chosen) select(chosen.event.id);
				}
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
			{blocks.filter((block, index) => index > 0 && blocks[index - 1]!.event.record.id !== block.event.record.id).map((block) => <span key={`turn-${block.event.record.id}`} className="trace-overview-boundary" aria-hidden="true" style={{ left: `${block.left * 100}%` }} />)}
			{gaps.map((gap) => <button type="button" key={gap.id} className="trace-overview-gap" aria-label={timelineGapLabel(gap)} {...tooltipHandlers(gap.id)} style={{ left: `${gap.left * 100}%`, width: `${gap.width * 100}%` }}><span aria-hidden="true">//</span></button>)}
			{blocks.map((block) => <button type="button" key={block.event.id} className={`trace-overview-block kind-${block.event.kind}`} aria-label={`${eventLabels[block.event.kind]} · ${block.event.summary}`} aria-pressed={selected === block.event.id}
				{...tooltipHandlers(block.event.id)}
				style={{ left: `${block.paintedLeft * 100}%`, width: `${block.paintedWidth * 100}%`, top: `${6 + block.lane * 14}px`, "--first-chunk": `${(block.firstChunk ?? 0) * 100}%` } as CSSProperties}
				data-event-id={block.event.id}
				data-first-chunk={block.firstChunk !== undefined || undefined}
				onClick={(event) => { if (event.detail === 0) select(block.event.id); }} />)}
			{range ? <span className="trace-overview-range" style={{ left: `${range.start * 100}%`, width: `${(range.end - range.start) * 100}%` }} /> : null}
		</div>
		{tooltipVisible && hovered && tooltipText !== undefined ? <TimelineTooltip id={tooltipId} anchor={hovered.anchor} text={tooltipText} /> : null}
	</section>;
}

/** Portal avoids clipping by the timeline and split panes; measure to keep the tooltip inside the viewport. */
function TimelineTooltip({ id, anchor, text }: { id: string; anchor: HTMLButtonElement; text: string }): React.JSX.Element {
	const element = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState({ left: 0, top: 0 });
	useLayoutEffect(() => {
		const place = () => {
			if (!element.current || !anchor.isConnected) return;
			const bounds = anchor.getBoundingClientRect(), tip = element.current.getBoundingClientRect();
			const left = Math.max(8, Math.min(bounds.left + bounds.width / 2 - tip.width / 2, window.innerWidth - tip.width - 8));
			const top = bounds.bottom + tip.height + 8 <= window.innerHeight ? bounds.bottom + 8 : Math.max(8, bounds.top - tip.height - 8);
			setPosition({ left, top });
		};
		place();
		const observer = new ResizeObserver(place); observer.observe(anchor); observer.observe(element.current!);
		window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
		return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
	}, [anchor, text]);
	return createPortal(<div ref={element} id={id} role="tooltip" className="trace-timeline-tooltip" style={position}>{text}</div>, document.body);
}
