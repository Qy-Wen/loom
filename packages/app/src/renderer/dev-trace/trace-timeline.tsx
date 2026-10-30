import { useRef, type CSSProperties } from "react";
import { eventLabels, timelineBlocks, type TraceEvent } from "./trace-events.ts";
import { formatTraceDuration } from "./trace-spans.ts";

export type FocusRange = { start: number; end: number } | null;
export function TraceTimeline({ events, actual, now, selected, range, setRange, select }: {
	events: readonly TraceEvent[]; actual: boolean; now: number; selected: string | null; range: FocusRange;
	setRange(range: FocusRange): void; select(id: string): void;
}): React.JSX.Element {
	const blocks = timelineBlocks(events, actual, now);
	const drag = useRef<{ pointer: number; start: number; x: number; moved: boolean } | null>(null);
	const fraction = (x: number, element: HTMLElement) => { const bounds = element.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - bounds.left) / Math.max(1, bounds.width))); };
	return <section className="trace-overview" aria-label="轨迹时间线">
		<div className="trace-lane-labels" aria-hidden="true"><span>输入</span><span>模型</span><span>工具</span></div>
		<div className="trace-overview-track" tabIndex={0} aria-label="时间线概览，拖动聚焦事件，Escape 清除范围" onKeyDown={(event) => { if (event.key === "Escape") setRange(null); }}
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
					const point = fraction(event.clientX, event.currentTarget);
					const lane = Math.max(0, Math.min(2, Math.floor((event.clientY - event.currentTarget.getBoundingClientRect().top - 6) / 14)));
					const candidates = blocks.filter((block) => block.lane === lane);
					const contained = candidates.filter((block) => point >= block.left && point <= block.left + block.width);
					const nearest = (contained.length ? contained : candidates).sort((a, b) => Math.abs(a.left + a.width / 2 - point) - Math.abs(b.left + b.width / 2 - point))[0];
					if (nearest) select(nearest.event.id);
				}
				if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
			}}
			onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
			{blocks.filter((block, index) => index > 0 && blocks[index - 1]!.event.record.id !== block.event.record.id).map((block) => <span key={`turn-${block.event.record.id}`} className="trace-overview-boundary" aria-hidden="true" style={{ left: `${block.left * 100}%` }} />)}
			{blocks.map((block) => <button type="button" key={block.event.id} className={`trace-overview-block kind-${block.event.kind}`} aria-label={`${eventLabels[block.event.kind]} · ${block.event.summary}`} aria-pressed={selected === block.event.id}
				title={`${block.event.label} · ${block.event.marker ? "请求快照，无独立耗时" : formatTraceDuration(Math.max(0, (block.event.span.endedMs ?? now) - block.event.span.startedMs))}${block.firstChunk === undefined ? "" : ` · 首 chunk ${formatTraceDuration(block.event.span.events.find((row) => row.name === "pi.ai.first_chunk")!.timeMs)}`}`}
				style={{ left: `${block.left * 100}%`, width: `max(2px, calc(${block.width * 100}% - 1px))`, top: `${6 + block.lane * 14}px`, "--first-chunk": `${(block.firstChunk ?? 0) * 100}%` } as CSSProperties}
				data-first-chunk={block.firstChunk !== undefined || undefined}
				onClick={(event) => { if (event.detail === 0) select(block.event.id); }} />)}
			{range ? <span className="trace-overview-range" style={{ left: `${range.start * 100}%`, width: `${(range.end - range.start) * 100}%` }} /> : null}
		</div>
	</section>;
}
