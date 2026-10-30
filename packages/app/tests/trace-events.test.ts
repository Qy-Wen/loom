import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoomTraceSpan } from "@loom/agent";
import type { DevTraceRecord } from "../src/shared/dev-trace.ts";
import { conversationId, contentText, eventForSpan, eventStatus, phaseDiagnostic, timelineBlocks, traceTurns } from "../src/renderer/dev-trace/trace-events.ts";

const span = (id: string, name: string, attributes: LoomTraceSpan["attributes"] = {}, parentId?: string): LoomTraceSpan => ({ id, name, attributes, parentId, traceId: "t", startedMs: 100, endedMs: 200, status: { status: "ok" }, events: [], links: [] });
function record(id: string, at = 100): DevTraceRecord {
	return { id, at, threadId: "1", revision: 1, status: "completed", spans: [
		span(`${id}-submit`, "pi.durable.submit", { "submission.type": "input" }),
		span(`${id}-phase`, "pi.durable.phase", { "task.name": "pi.generation", phase: "request", attempt: 1, outcome: "waiting" }),
		span(`${id}-request`, "pi.ai.request", { model: "demo", "loom.io.input": JSON.stringify([{ role: "system", sections: { preamble: "SYSTEM", instructions: "<instructions>\n\n</instructions>" } }, { role: "assistant", content: "old reply" }, { role: "user", content: `question-${id}` }]), "loom.io.output": JSON.stringify([{ type: "thinking", thinking: "THOUGHT" }, { type: "text", text: `reply-${id}` }]) }, `${id}-phase`),
		span(`${id}-tool`, "pi.durable.phase", { "task.name": "pi.tool", "tool.name": "bash", phase: "call", "loom.io.input": '{"command":"ls"}', "loom.io.output": JSON.stringify({ content: [{ type: "text", text: "2 files" }] }) }),
	] };
}

test("event projection keeps turns distinct and avoids duplicating request history and orchestration", () => {
	const records = [record("b", 200), record("a", 100)];
	const turns = traceTurns(records);
	assert.deepEqual(turns.map((turn) => turn.id), ["a", "b"]);
	assert.deepEqual(turns[0]!.events.map((row) => row.kind), ["system", "user", "assistant", "tool"]);
	assert.deepEqual(turns[1]!.events.map((row) => row.kind), ["user", "assistant", "tool"]);
	assert.equal(turns[1]!.events[0]!.text, "question-b");
	assert.match(turns[0]!.events.at(-1)!.summary, /bash.*ls.*→ 2 files/);
	assert.deepEqual(turns.map((turn) => turn.events.find((row) => row.kind === "assistant")!.step), [1, 1]);
	assert.ok(turns.flatMap((turn) => turn.events).every((event) => !("request" in event)));
	assert.equal(eventForSpan(turns, "a-phase"), undefined); // Hidden native phases must be inspected by their exact identity, not a descendant.
	assert.equal(eventForSpan(turns, "a-submit")!.kind, "user");
	assert.equal(turns[0]!.events[2]!.span, records[1]!.spans[2]);
	assert.equal(conversationId({ ...records[0]!, threadId: "" }), "trace:b");
});

test("legacy or absent inputs are not fabricated and exceptional phases stay visible", () => {
	const legacy = record("legacy"); legacy.spans[2] = { ...legacy.spans[2]!, attributes: { "loom.io.input": '[{"cut":' } };
	legacy.spans.push(span("approval", "loom.approval", { "tool.name": "publish" }));
	legacy.spans.push(span("retry", "pi.durable.phase", { "task.name": "pi.generate", phase: "prepare", attempt: 2 }));
	legacy.spans.push({ ...span("interrupted", "pi.durable.phase"), interrupted: true });
	const events = traceTurns([legacy])[0]!.events;
	assert.equal(events.find((event) => event.kind === "user")!.text, undefined);
	assert.ok(events.some((event) => event.kind === "approval"));
	assert.equal(events.find((event) => event.span.id === "retry")!.label, "重试");
	assert.equal(events.find((event) => event.span.id === "retry")!.summary, "模型请求重试 · 第 2 次");
	assert.equal(eventStatus(events.find((event) => event.span.id === "interrupted")!), "interrupted");
	assert.deepEqual(traceTurns([{ ...legacy, spans: [] }])[0]!.events, []);
});

test("routine scheduling stays hidden, even without other readable events", () => {
	for (const outcome of ["waiting", "sleeping", "done", "next=tools"]) {
		const phases = ["prepare", "request", "tools"].map((phase) => span(phase, "pi.durable.phase", { "task.name": "pi.generation", phase, attempt: 1, outcome }));
		const normal = traceTurns([{ ...record("normal"), spans: phases }])[0]!;
		assert.deepEqual(normal.events, []);
		for (const phase of phases) assert.equal(phaseDiagnostic(phase), undefined);
	}
	const repeatedRequest = span("retry-request", "pi.durable.phase", { "task.name": "pi.generation", phase: "request", attempt: 2, outcome: "waiting" });
	assert.equal(phaseDiagnostic(repeatedRequest), undefined);
	assert.equal(phaseDiagnostic(span("specialist", "pi.durable.phase", { "task.name": "pi.specialist", phase: "run", outcome: "waiting" })), undefined);
});

test("diagnostics use readable descriptions while preserving native identities and errors", () => {
	const failure = { ...span("failure", "pi.durable.phase", { "task.name": "pi.generation", phase: "request" }), status: { status: "error" as const, error: { name: "Error", message: "Connection failed" } } };
	const compaction = span("compact", "pi.durable.phase", { "task.name": "pi.compaction", phase: "summarize" });
	const backoff = span("backoff", "pi.durable.phase", { "task.name": "pi.generation", phase: "retry", attempt: 1, outcome: "sleeping" });
	const cancelled = span("cancelled", "pi.durable.phase", { "task.name": "pi.generation", phase: "request", outcome: "aborted" });
	assert.deepEqual(phaseDiagnostic(failure), { label: "异常", summary: "模型请求失败 · Connection failed" });
	assert.deepEqual(phaseDiagnostic(compaction), { label: "压缩", summary: "上下文压缩" });
	assert.deepEqual(phaseDiagnostic(backoff), { label: "重试", summary: "模型请求等待重试" });
	assert.deepEqual(phaseDiagnostic(cancelled), { label: "中断", summary: "模型请求已取消" });
	const source = { ...record("diagnostic"), spans: [failure, compaction, backoff, cancelled] };
	const turn = traceTurns([source])[0]!;
	assert.deepEqual(turn.events.map((event) => event.label), ["异常", "压缩", "重试", "中断"]);
	assert.equal(eventForSpan([turn], "failure")!.span, failure);
	assert.equal(source.spans.length, 4);
});

test("content decoding resolves blobs but does not parse JSON-looking message strings", () => {
	const row = record("blob"); row.blobs = { "0123456789abcdef": "FULL text" };
	assert.equal(contentText("preview… ⟦blob:0123456789abcdef:9⟧", row), "FULL text");
	assert.equal(contentText('{"not":"an object"}', row), '{"not":"an object"}');
	assert.equal(contentText({ type: "image", data: "do not show" }, row), "[image omitted]");
});

test("timeline uses equal widths or true overlapping times, with zero-duration input markers", () => {
	const events = traceTurns([record("time")])[0]!.events;
	const equal = timelineBlocks(events, false, 300);
	assert.equal(equal[0]!.width, .25); assert.equal(equal[1]!.left, .25);
	const actual = timelineBlocks(events, true, 300);
	assert.equal(actual[0]!.width, 0); assert.equal(actual[1]!.width, 0);
	assert.equal(actual[2]!.left, actual[3]!.left);
	assert.equal(actual[2]!.width, 1); assert.equal(actual[2]!.lane, 1); assert.equal(actual[3]!.lane, 2);
	const running = events.map((event) => event.kind === "assistant" ? { ...event, span: { ...event.span, endedMs: undefined, events: [{ name: "pi.ai.first_chunk", timeMs: 50, attributes: {} }] } } : event);
	const blocks = timelineBlocks(running, true, 300);
	assert.equal(blocks[2]!.firstChunk, .25); assert.equal(blocks[2]!.width, 1);
	assert.deepEqual(timelineBlocks([], true, 0), []);
});
