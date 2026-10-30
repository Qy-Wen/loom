import assert from "node:assert/strict";
import { test } from "node:test";
import type { DevTraceRecord } from "../src/shared/dev-trace.ts";
import type { TraceEvent } from "../src/renderer/dev-trace/trace-events.ts";
import { timelineGapLabel, timelineLayout } from "../src/renderer/dev-trace/trace-timeline-layout.ts";

function turn(id: string, intervals: [number, number | undefined][]): { record: DevTraceRecord; events: TraceEvent[] } {
	const record: DevTraceRecord = { id, threadId: "conversation", at: intervals[0]![0], revision: 1, status: "completed", spans: intervals.map(([startedMs, endedMs], index) => ({ id: `${id}-${index}`, traceId: id, name: "pi.ai.request", startedMs, endedMs, attributes: {}, links: [], events: [], status: { status: "ok" } })) };
	return { record, events: record.spans.map((span, index) => ({ id: span.id, kind: "assistant", label: "助手", summary: "reply", record, span, step: index + 1, marker: false })) };
}
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("long inter-turn idle gaps become pixel separators while all calls use one duration scale", () => {
	const first = turn("first", [[0, 1000], [1000, 3000]]), second = turn("second", [[723_000, 724_000]]);
	first.events[0]!.span = { ...first.events[0]!.span, events: [{ name: "pi.ai.first_chunk", timeMs: 500, attributes: {} }] };
	const events = [...first.events, ...second.events], records = [first.record, second.record];
	const before = JSON.stringify(records);
	const { blocks, gaps } = timelineLayout(events, true, 724_000, 1000, records);
	assert.equal(gaps.length, 1);
	assert.equal(timelineGapLabel(gaps[0]!), "轮间间隔 12分钟（已折叠）");
	close(gaps[0]!.width * 1000, 12);
	close(blocks[0]!.width, blocks[2]!.width);
	close(blocks[1]!.width, blocks[0]!.width * 2);
	close(blocks[2]!.left - (blocks[1]!.left + blocks[1]!.width), gaps[0]!.width);
	close(blocks[2]!.left + blocks[2]!.width, 1);
	assert.equal(blocks[0]!.firstChunk, .5);
	assert.equal(blocks[0]!.event, first.events[0]);
	assert.equal(JSON.stringify(records), before);
	const resized = timelineLayout(events, true, 724_000, 500, records);
	close(resized.gaps[0]!.width * 500, 12);
	close(resized.blocks[0]!.width, resized.blocks[2]!.width);
});

test("within-turn idle time is retained even with a later folded turn", () => {
	const first = turn("first", [[0, 1000], [10_000, 11_000]]), second = turn("second", [[100_000, 101_000]]);
	const { blocks, gaps } = timelineLayout([...first.events, ...second.events], true, 101_000, 1000, [first.record, second.record]);
	assert.deepEqual(gaps.map((gap) => [gap.startMs, gap.endMs]), [[11_000, 100_000]]);
	close(blocks[1]!.left - blocks[0]!.width, blocks[0]!.width * 9);
});

test("overlapping turns and hidden native spans protect active time, including records with no ledger events", () => {
	const first = turn("first", [[0, 1000]]), second = turn("second", [[100_000, 101_000]]);
	const hidden = turn("hidden", [[1000, 100_000]]);
	const events = [...first.events, ...second.events];
	assert.equal(timelineLayout(events, true, 101_000, 1000, [first.record, hidden.record, second.record]).gaps.length, 0);
	const overlapping = turn("overlap", [[500, 100_500]]);
	assert.equal(timelineLayout([...events, ...overlapping.events], true, 101_000, 1000).gaps.length, 0);
	const nested = turn("nested", [[200, 300]]), fourth = turn("fourth", [[200_000, 201_000]]);
	const merged = timelineLayout([...first.events, ...nested.events, ...overlapping.events, ...second.events, ...fourth.events], true, 201_000, 1000);
	assert.deepEqual(merged.gaps.map((gap) => [gap.startMs, gap.endMs]), [[101_000, 200_000]]);
});

test("running/deferred native work prevents folding until it settles, without changing elapsed durations", () => {
	const first = turn("first", [[0, 1000]]), second = turn("second", [[100_000, 101_000]]);
	first.record.spans.push({ ...first.record.spans[0]!, id: "deferred", name: "pi.durable.phase", startedMs: 1000, endedMs: undefined });
	const events = [...first.events, ...second.events], records = [first.record, second.record];
	assert.equal(timelineLayout(events, true, 101_000, 1000, records).gaps.length, 0);
	first.record.spans[1] = { ...first.record.spans[1]!, endedMs: 80_000 };
	const settled = timelineLayout(events, true, 101_000, 1000, records);
	assert.deepEqual(settled.gaps.map((gap) => [gap.startMs, gap.endMs]), [[80_000, 100_000]]);
	close(settled.blocks[0]!.width, settled.blocks[1]!.width);
});

test("many gaps stay within a bounded visual budget and zero-duration calls still have zero measured width", () => {
	const turns = Array.from({ length: 30 }, (_, i) => turn(String(i), [[i * 100_000, i * 100_000 + 1000]]));
	const { blocks, gaps } = timelineLayout(turns.flatMap((turn) => turn.events), true, 3_000_000, 100, turns.map((turn) => turn.record));
	close(gaps.reduce((sum, gap) => sum + gap.width, 0), .2);
	close(blocks[0]!.width, blocks.at(-1)!.width);
	close(blocks.at(-1)!.left + blocks.at(-1)!.width, 1);
	const zero = turn("zero", [[0, 0]]), later = turn("later", [[100_000, 100_000]]);
	const points = timelineLayout([...zero.events, ...later.events], true, 100_000, 1000);
	assert.equal(points.blocks[0]!.width, 0); assert.equal(points.blocks[1]!.width, 0);
	assert.ok(points.blocks.every((block) => Number.isFinite(block.left)));
	assert.equal(points.gaps.length, 1);
});

test("instantaneous boundary events occupy successive slots before the next call across lanes", () => {
	const source = turn("source", [[0, 0], [0, 0], [0, 1000], [1000, 1000], [1000, 2000], [2000, 2000]]);
	source.events[0] = { ...source.events[0]!, kind: "user", marker: true };
	source.events[1] = { ...source.events[1]!, kind: "context", marker: true };
	source.events[3] = { ...source.events[3]!, kind: "tool" };
	const before = JSON.stringify(source.record);
	for (const extent of [1000, 400]) {
		const { blocks } = timelineLayout(source.events, true, 2000, extent, [source.record]);
		for (const index of [0, 1, 3, 5]) {
			close(blocks[index]!.paintedWidth * extent, 6);
			assert.equal(blocks[index]!.width, 0);
		}
		for (const index of [0, 1, 3]) close(blocks[index]!.paintedLeft + blocks[index]!.paintedWidth, blocks[index + 1]!.paintedLeft);
		close(blocks[2]!.width, blocks[4]!.width); // One true duration scale despite marker slots.
		close(blocks[5]!.paintedLeft + blocks[5]!.paintedWidth, 1);
	}
	assert.equal(JSON.stringify(source.record), before);
});

test("system request snapshots precede the earlier user submission without rewriting source timestamps", () => {
	const source = turn("snapshot", [[100, 1000], [0, 1]]);
	const request = source.record.spans[0]!, submit = source.record.spans[1]!;
	const events: TraceEvent[] = [
		{ ...source.events[0]!, id: "system", kind: "system", marker: true },
		{ ...source.events[1]!, id: "user", kind: "user", marker: true },
		source.events[0]!,
	];
	for (const actual of [true, false]) {
		const { blocks } = timelineLayout(events, actual, 1000, 1000, [source.record]);
		assert.ok(blocks[0]!.paintedLeft < blocks[1]!.paintedLeft);
		assert.ok(blocks[1]!.paintedLeft < blocks[2]!.paintedLeft);
		if (actual) close(blocks[0]!.paintedLeft + blocks[0]!.paintedWidth, blocks[1]!.paintedLeft);
		assert.equal(blocks[0]!.event.span, request);
		assert.equal(blocks[0]!.event.span.startedMs, 100);
		assert.equal(blocks[1]!.event.span, submit);
		assert.equal(blocks[0]!.width, actual ? 0 : 1 / 3);
	}
});

test("sub-ms calls displayed as 0ms also reserve space before successive calls", () => {
	const source = turn("rounded-zero", [[0, .1], [.1, .3], [.3, 1000]]);
	const { blocks } = timelineLayout(source.events, true, 1000, 1000);
	for (const index of [0, 1]) {
		assert.ok(blocks[index]!.width > 0); // Stored elapsed time is not rounded away.
		close(blocks[index]!.paintedWidth * 1000, 6);
		const gap = (blocks[index + 1]!.paintedLeft - blocks[index]!.paintedLeft - blocks[index]!.paintedWidth) * 1000;
		assert.ok(gap >= 0 && gap < 1, `sub-ms visual gap ${gap}`);
	}
});

test("gaps start after terminal zero events and finish before the next turn's instantaneous inputs", () => {
	const first = turn("first", [[0, 1000], [1000, 1000]]), second = turn("second", [[100_000, 100_000], [100_000, 101_000]]);
	const { blocks, gaps } = timelineLayout([...first.events, ...second.events], true, 101_000, 1000, [first.record, second.record]);
	close(blocks[1]!.paintedLeft + blocks[1]!.paintedWidth, gaps[0]!.left);
	close(gaps[0]!.left + gaps[0]!.width, blocks[2]!.paintedLeft);
	close(blocks[2]!.paintedLeft + blocks[2]!.paintedWidth, blocks[3]!.paintedLeft);
	close(blocks[0]!.width, blocks[3]!.width);
});

test("zero-duration points inside actual concurrent work do not move or stretch parallel spans", () => {
	const source = turn("parallel", [[0, 2000], [1000, 1000], [1000, 2000], [1000, 2000]]);
	const { blocks } = timelineLayout(source.events, true, 2000, 1000);
	close(blocks[0]!.width, 1);
	close(blocks[1]!.left, .5);
	close(blocks[2]!.left, blocks[3]!.left);
	close(blocks[2]!.width, blocks[3]!.width);
});

test("equal-event mode remains independent of wall-clock gaps", () => {
	const first = turn("first", [[0, 1000]]), second = turn("second", [[100_000, 101_000]]);
	const layout = timelineLayout([...first.events, ...second.events], false, 101_000, 1000);
	assert.deepEqual(layout.gaps, []);
	assert.deepEqual(layout.blocks.map((block) => [block.left, block.width]), [[0, .5], [.5, .5]]);
	assert.equal(timelineGapLabel({ startMs: 0, endMs: 7_200_000 }), "轮间间隔 2小时（已折叠）");
});
