import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useTraceLocale } from "./trace-locale.tsx";
import { timelineGapLabel, type TimelineLayout } from "./trace-timeline-layout.ts";
import { formatTraceDuration } from "./trace-spans.ts";

export type FocusRange = { start: number; end: number } | null;
export function TraceTimeline({ layout, onWidthChange, now, selected, range, setRange, select }: {
	layout: TimelineLayout; onWidthChange(width: number): void; now: number; selected: string | null; range: FocusRange;
	setRange(range: FocusRange): void; select(id: string): void;
}): React.JSX.Element {
	const { t } = useTraceLocale();
	const { blocks, gaps } = layout;
	const track = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const measure = () => onWidthChange(track.current!.getBoundingClientRect().width);
		measure();
		const observer = new ResizeObserver(measure); observer.observe(track.current!);
		return () => observer.disconnect();
	}, [onWidthChange]);
	const drag = useRef<{ pointer: number; start: number; x: number; moved: boolean } | null>(null);
	const tooltipText = (block: typeof blocks[number]) => `${block.event.label} · ${block.event.marker ? t.timeline.snapshot : formatTraceDuration(Math.max(0, (block.event.span.endedMs ?? now) - block.event.span.startedMs))}${block.firstChunk === undefined ? "" : ` · ${t.timeline.firstChunk(formatTraceDuration(block.event.span.events.find((row) => row.name === "pi.ai.first_chunk")!.timeMs))}`}`;
	const fraction = (x: number, element: HTMLElement) => { const bounds = element.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - bounds.left) / Math.max(1, bounds.width))); };
	return <section className="trace-overview" aria-label={t.timeline.label}>
		<div className="trace-lane-labels" aria-hidden="true"><span>{t.timeline.lanes.input}</span><span>{t.timeline.lanes.model}</span><span>{t.timeline.lanes.tools}</span></div>
		<div ref={track} className="trace-overview-track" tabIndex={0} aria-label={t.timeline.track} onKeyDown={(event) => { if (event.key === "Escape") { setRange(null); } }}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
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
			{gaps.map((gap) => <button type="button" key={gap.id} className="trace-overview-gap" aria-label={timelineGapLabel(gap, t)} data-tooltip={timelineGapLabel(gap, t)} style={{ left: `${gap.left * 100}%`, width: `${gap.width * 100}%` }}><span aria-hidden="true">//</span></button>)}
			{blocks.map((block) => <button type="button" key={block.event.id} className={`trace-overview-block kind-${block.event.kind}`} aria-label={`${t.kinds[block.event.kind]} · ${block.event.summary}`} aria-pressed={selected === block.event.id}
				data-tooltip={tooltipText(block)}
				style={{ left: `${block.paintedLeft * 100}%`, width: `${block.paintedWidth * 100}%`, top: `${6 + block.lane * 14}px`, "--first-chunk": `${(block.firstChunk ?? 0) * 100}%` } as CSSProperties}
				data-event-id={block.event.id}
				data-first-chunk={block.firstChunk !== undefined || undefined}
				onClick={(event) => { if (event.detail === 0) select(block.event.id); }} />)}
			{range ? <span className="trace-overview-range" style={{ left: `${range.start * 100}%`, width: `${(range.end - range.start) * 100}%` }} /> : null}
		</div>
	</section>;
}
