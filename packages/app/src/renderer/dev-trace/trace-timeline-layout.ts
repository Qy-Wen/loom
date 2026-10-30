import type { DevTraceRecord } from "../../shared/dev-trace.ts";
import type { TraceEvent } from "./trace-events.ts";
import type { TraceMessages } from "./trace-messages.ts";
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

/**
 * One shared projection for drawing, clicks and range focus. Inter-turn idle intervals lose their wall-clock width.
 *
 * Actual mode keeps the time order but not the proportions: every block is drawn at least `MIN_BLOCK_WIDTH` wide, and a
 * block that starts after another has finished never starts left of that block's right edge, so successive work never
 * overlaps. Work that really runs at the same time (a start inside a call that is still running) is not staggered.
 * The time scale shrinks, by bisection, until the whole thing fits the track.
 */
export function timelineLayout(events: readonly TraceEvent[], actual: boolean, now: number, extent: number, records: readonly DevTraceRecord[] = []): TimelineLayout {
	if (!events.length) return { blocks: [], gaps: [] };
	const minimum = MIN_BLOCK_WIDTH / Math.max(MIN_BLOCK_WIDTH, extent);
	const gutter = 1 / Math.max(1, extent);
	const lane = (event: TraceEvent) => event.kind === "assistant" ? 1 : ["tool", "approval", "phase"].includes(event.kind) ? 2 : 0;
	const firstChunk = (event: TraceEvent, duration: number) => {
		const first = event.span.events.find((row) => row.name === "pi.ai.first_chunk")?.timeMs;
		return event.kind === "assistant" && typeof first === "number" && duration > 0 ? Math.min(1, Math.max(0, first / duration)) : undefined;
	};
	const durations = events.map((event) => event.marker ? 0 : Math.max(0, (event.span.endedMs ?? now) - event.span.startedMs));
	if (!actual) {
		return { gaps: [], blocks: events.map((event, index) => {
			const width = 1 / events.length, paintedWidth = Math.max(minimum, width - gutter);
			return { event, lane: lane(event), left: index / events.length, width, paintedLeft: Math.max(0, Math.min(index / events.length, 1 - paintedWidth)), paintedWidth, firstChunk: firstChunk(event, durations[index]!) };
		}) };
	}
	// The system prompt is a request snapshot, not work that started after the user's submission.
	// Place it with that turn's input markers in ledger order, but retain the original source span/timestamps.
	const inputs = new Map<string, number>();
	for (const event of events) if (event.kind === "user" && event.marker) inputs.set(event.record.id, Math.min(inputs.get(event.record.id) ?? Infinity, event.span.startedMs));
	const starts = events.map((event) => event.kind === "system" && event.marker ? Math.min(event.span.startedMs, inputs.get(event.record.id) ?? event.span.startedMs) : event.span.startedMs);
	const start = Math.min(...starts);
	const end = Math.max(start, ...events.map((event, index) => event.marker ? starts[index]! : event.span.endedMs ?? now));
	const intervals = idleGaps(events, records, now)
		.map((gap) => ({ ...gap, startMs: Math.max(start, gap.startMs), endMs: Math.min(end, gap.endMs) }))
		.filter((gap) => gap.endMs > gap.startMs);
	const idleMs = intervals.reduce((sum, gap) => sum + gap.endMs - gap.startMs, 0);
	const activeMs = Math.max(1, end - start - idleMs);
	// On crowded/narrow timelines, separators share at most 20% of the track rather than squeezing all calls away.
	const gapWidth = intervals.length ? Math.min(GAP_WIDTH / Math.max(1, extent), .2 / intervals.length) : 0;

	// Events and idle gaps are placed in one time order. At equal start times a gap goes after the events (a turn's closing
	// zero-length events end before the gap), otherwise ledger order decides.
	type Item = { startMs: number; endMs: number; event?: number; gap?: number };
	const items: Item[] = [
		...events.map((_event, index): Item => ({ startMs: starts[index]!, endMs: starts[index]! + durations[index]!, event: index })),
		...intervals.map((gap, index): Item => ({ startMs: gap.startMs, endMs: gap.endMs, gap: index })),
	].sort((a, b) => a.startMs - b.startMs || (a.gap === undefined ? 0 : 1) - (b.gap === undefined ? 0 : 1) || (a.event ?? 0) - (b.event ?? 0));
	// Time drawn to scale before `time`, and the number of separators before it, so the natural position is scaled*perMs + separators*gapWidth.
	const natural = items.map((item) => {
		let removed = 0, separators = 0;
		for (const gap of intervals) {
			if (item.startMs <= gap.startMs) break;
			if (item.startMs < gap.endMs) return { scaled: gap.startMs - start - removed, separators: separators + (item.startMs - gap.startMs) / (gap.endMs - gap.startMs) };
			removed += gap.endMs - gap.startMs; separators++;
		}
		return { scaled: item.startMs - start - removed, separators };
	});
	// A zero-length event that starts inside a still-running call is concurrent with whatever else starts at that same
	// instant, so it must not push those aside.
	const covered: boolean[] = [];
	{
		let open: Item[] = [];
		for (const item of items) {
			open = open.filter((other) => other.endMs > item.startMs);
			covered.push(item.event !== undefined && open.some((other) => other.startMs < item.startMs));
			if (item.event !== undefined) open.push(item);
		}
	}
	const place = (perMs: number, slot: number) => {
		const lefts: number[] = [], rights: number[] = [];
		let open: number[] = [], floor = 0, reach = 0;
		items.forEach((item, position) => {
			const keep: number[] = [];
			for (const other of open) {
				if (items[other]!.endMs <= item.startMs && !(covered[other] && items[other]!.startMs === item.startMs)) floor = Math.max(floor, rights[other]!);
				else keep.push(other);
			}
			open = keep;
			const left = Math.max(natural[position]!.scaled * perMs + natural[position]!.separators * gapWidth, floor);
			lefts[position] = left;
			rights[position] = left + (item.gap !== undefined ? gapWidth : Math.max(slot, (item.endMs - item.startMs) * perMs));
			reach = Math.max(reach, rights[position]!);
			open.push(position);
		});
		return { lefts, rights, reach };
	};
	// Largest time scale that fits. If even a zero scale does not fit, shrink the minimum width instead (blocks then
	// may touch or overlap on a track too narrow for them all).
	const naturalScale = Math.max(0, 1 - gapWidth * intervals.length) / activeMs;
	const bisect = (low: number, high: number, fits: (value: number) => boolean) => {
		for (let step = 0; step < 60; step++) { const middle = (low + high) / 2; if (fits(middle)) low = middle; else high = middle; }
		return low;
	};
	let perMs = naturalScale, slot = minimum;
	if (place(perMs, slot).reach > 1) {
		if (place(0, slot).reach <= 1) perMs = bisect(0, naturalScale, (value) => place(value, slot).reach <= 1);
		else { perMs = 0; slot = bisect(0, minimum, (value) => place(0, value).reach <= 1); }
	}
	const placed = place(perMs, slot);
	const position = new Map(items.map((item, index) => [item.event ?? -1 - item.gap!, index]));
	return {
		gaps: intervals.map((gap, index) => ({ ...gap, left: placed.lefts[position.get(-1 - index)!]!, width: gapWidth })),
		blocks: events.map((event, index) => {
			const left = placed.lefts[position.get(index)!]!, width = durations[index]! * perMs;
			const paintedWidth = Math.max(slot, width - gutter);
			return { event, lane: lane(event), left, width, paintedLeft: Math.max(0, Math.min(left, 1 - paintedWidth)), paintedWidth, firstChunk: firstChunk(event, durations[index]!) };
		}),
	};
}

export function timelineGapLabel(gap: Pick<TimelineGap, "startMs" | "endMs">, t: TraceMessages): string {
	const ms = gap.endMs - gap.startMs;
	const duration = ms >= 3_600_000 ? t.timeline.hours(Number((ms / 3_600_000).toFixed(1))) : ms >= 60_000 ? t.timeline.minutes(Number((ms / 60_000).toFixed(1))) : formatTraceDuration(ms);
	return t.timeline.gap(duration);
}
