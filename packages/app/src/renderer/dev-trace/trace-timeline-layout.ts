import type { DevTraceRecord } from "../../shared/dev-trace.ts";
import type { TraceEvent } from "./trace-events.ts";
import { formatTraceDuration } from "./trace-spans.ts";

export type TimelineBlock = { event: TraceEvent; left: number; width: number; paintedLeft: number; paintedWidth: number; lane: number; firstChunk?: number };
export type TimelineGap = { id: string; startMs: number; endMs: number; left: number; width: number };
export type TimelineLayout = { blocks: TimelineBlock[]; gaps: TimelineGap[] };
const GAP_WIDTH = 12;
const MIN_BLOCK_WIDTH = 6;

type Interval = { id: string; startMs: number; endMs: number };
/** A whole native turn is occupied, including hidden phases and deferred waits. Overlapping turns form one interval. */
function idleGaps(events: readonly TraceEvent[], records: readonly DevTraceRecord[], now: number): Interval[] {
	const turns = new Map<string, Interval>();
	const include = (id: string, startMs: number, endMs: number) => {
		const old = turns.get(id);
		turns.set(id, { id, startMs: Math.min(old?.startMs ?? startMs, startMs), endMs: Math.max(old?.endMs ?? startMs, startMs, endMs) });
	};
	for (const record of records) for (const span of record.spans) include(record.id, span.startedMs, span.endedMs ?? now);
	// Also cover the displayed revisions, including standalone test/legacy events without native records.
	for (const event of events) include(event.record.id, event.span.startedMs, event.span.endedMs ?? now);
	const intervals = [...turns.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
	const gaps: Interval[] = [];
	let covered: Interval | undefined;
	for (const interval of intervals) {
		if (covered && interval.startMs > covered.endMs) gaps.push({ id: `gap:${covered.id}/${interval.id}`, startMs: covered.endMs, endMs: interval.startMs });
		if (!covered || interval.startMs > covered.endMs || interval.endMs > covered.endMs) covered = interval;
	}
	return gaps;
}

/** One shared projection for drawing, clicks and range focus. Only inter-turn idle intervals lose their wall-clock width. */
export function timelineLayout(events: readonly TraceEvent[], actual: boolean, now: number, extent: number, records: readonly DevTraceRecord[] = []): TimelineLayout {
	if (!events.length) return { blocks: [], gaps: [] };
	// The system prompt is a request snapshot, not work that started after the user's submission.
	// Place it with that turn's input markers in ledger order, but retain the original source span/timestamps.
	const inputs = new Map<string, number>();
	for (const event of events) if (event.kind === "user" && event.marker) inputs.set(event.record.id, Math.min(inputs.get(event.record.id) ?? Infinity, event.span.startedMs));
	const starts = events.map((event) => event.kind === "system" && event.marker ? Math.min(event.span.startedMs, inputs.get(event.record.id) ?? event.span.startedMs) : event.span.startedMs);
	const start = Math.min(...starts);
	const end = Math.max(start, ...events.map((event, index) => event.marker ? starts[index]! : event.span.endedMs ?? now));
	const intervals = actual ? idleGaps(events, records, now)
		.map((gap) => ({ ...gap, startMs: Math.max(start, gap.startMs), endMs: Math.min(end, gap.endMs) }))
		.filter((gap) => gap.endMs > gap.startMs) : [];
	const activeMs = Math.max(1, end - start - intervals.reduce((sum, gap) => sum + gap.endMs - gap.startMs, 0));
	// On crowded/narrow timelines, separators share at most 20% of the track rather than squeezing all calls away.
	const gapWidth = intervals.length ? Math.min(GAP_WIDTH / Math.max(1, extent), .2 / intervals.length) : 0;
	const durations = events.map((event) => event.marker ? 0 : Math.max(0, (event.span.endedMs ?? now) - event.span.startedMs));
	// Reserve display-only slots for events displayed as 0ms (including sub-ms calls) at execution boundaries. Points inside a running
	// call are genuinely concurrent; do not turn those into sequential work or lengthen the covering call.
	const slots = actual ? starts.map((time, index) => ({ index, time }))
		.filter((slot) => durations[slot.index]! < .5 && !events.some((_event, index) => durations[index]! > 0 && starts[index]! < slot.time && starts[index]! + durations[index]! > slot.time))
		.sort((a, b) => a.time - b.time || a.index - b.index) : [];
	const slotWidth = slots.length ? Math.min(MIN_BLOCK_WIDTH / Math.max(MIN_BLOCK_WIDTH, extent), .4 / slots.length) : 0;
	const timeWidth = 1 - gapWidth * intervals.length - slotWidth * slots.length;
	const projectTime = (time: number) => {
		let removed = 0, separators = 0;
		for (const gap of intervals) {
			if (time <= gap.startMs) break;
			if (time < gap.endMs) return (gap.startMs - start - removed) / activeMs * timeWidth + (separators + (time - gap.startMs) / (gap.endMs - gap.startMs)) * gapWidth;
			removed += gap.endMs - gap.startMs; separators++;
		}
		return (time - start - removed) / activeMs * timeWidth + separators * gapWidth;
	};
	const project = (time: number, afterSlots = true) => projectTime(time) + slots.filter((slot) => slot.time < time || (afterSlots && slot.time === time)).length * slotWidth;
	const minimum = MIN_BLOCK_WIDTH / Math.max(MIN_BLOCK_WIDTH, extent);
	return {
		gaps: intervals.map((gap) => ({ ...gap, left: project(gap.startMs), width: gapWidth })),
		blocks: events.map((event, index) => {
			const duration = durations[index]!;
			const first = event.span.events.find((row) => row.name === "pi.ai.first_chunk")?.timeMs;
			const slot = slots.find((slot) => slot.index === index);
			const left = actual ? slot ? project(starts[index]!, false) + slots.filter((item) => item.time === slot.time && item.index < index).length * slotWidth : project(starts[index]!) : index / events.length;
			const width = actual ? duration / activeMs * timeWidth : 1 / events.length;
			const paintedWidth = Math.max(minimum, width - 1 / Math.max(1, extent));
			return { event, lane: event.kind === "assistant" ? 1 : ["tool", "approval", "phase"].includes(event.kind) ? 2 : 0,
				left, width, paintedLeft: Math.max(0, Math.min(left, 1 - paintedWidth)), paintedWidth,
				firstChunk: event.kind === "assistant" && typeof first === "number" && duration > 0 ? Math.min(1, Math.max(0, first / duration)) : undefined };
		}),
	};
}

export function timelineGapLabel(gap: Pick<TimelineGap, "startMs" | "endMs">): string {
	const ms = gap.endMs - gap.startMs;
	const duration = ms >= 3_600_000 ? `${Number((ms / 3_600_000).toFixed(1))}小时` : ms >= 60_000 ? `${Number((ms / 60_000).toFixed(1))}分钟` : formatTraceDuration(ms);
	return `轮间间隔 ${duration}（已折叠）`;
}
