import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoomTraceSpan } from "@loom/agent";
import type { DevTraceRecord } from "../src/shared/dev-trace.ts";
import type { JsonValue } from "../src/renderer/dev-trace/json-values.ts";
import { timelineLayout } from "../src/renderer/dev-trace/trace-timeline-layout.ts";
import { capturedTools, conversationId, contentText, eventForSpan, eventStatus, phaseDiagnostic, traceTurns } from "../src/renderer/dev-trace/trace-events.ts";

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
	assert.equal(turns[0]!.events[0]!.summary, "系统提示词");
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
	assert.equal(events.find((event) => event.kind === "user")!.rawContent, undefined);
	assert.ok(events.some((event) => event.kind === "approval"));
	assert.equal(events.find((event) => event.span.id === "retry")!.label, "重试");
	assert.equal(events.find((event) => event.span.id === "retry")!.summary, "模型请求重试 · 第 2 次");
	assert.equal(eventStatus(events.find((event) => event.span.id === "interrupted")!), "interrupted");
	assert.deepEqual(traceTurns([{ ...legacy, spans: [] }])[0]!.events, []);
});

test("snapshot raw content isolates each captured fragment while retaining blobs, structure, and source identity", () => {
	const row = record("snapshot");
	const preamble = "preview… ⟦blob:0123456789abcdef:11⟧";
	const instructions = "CONTEXT_ONLY";
	const user = [{ type: "text", text: "USER_ONLY" }, { type: "image", image: "[omitted]" }];
	const input = JSON.stringify([{ role: "system", sections: { preamble, instructions } }, { role: "assistant", content: "OLD_REPLY" }, { role: "user", content: user }]);
	row.blobs = { "0123456789abcdef": "SYSTEM_ONLY" };
	row.spans = row.spans.filter((span) => span.name !== "pi.durable.submit");
	const source = row.spans.find((span) => span.name === "pi.ai.request")!;
	const request = { ...source, attributes: { ...source.attributes, "loom.io.input": input } };
	row.spans = row.spans.map((span) => span.id === request.id ? request : span);
	const events = traceTurns([row])[0]!.events;
	const system = events.find((event) => event.kind === "system")!;
	const context = events.find((event) => event.kind === "context")!;
	const question = events.find((event) => event.kind === "user")!;
	assert.equal(JSON.parse(system.rawContent!), preamble);
	assert.equal(system.text, "SYSTEM_ONLY");
	assert.equal(JSON.parse(context.rawContent!), instructions);
	assert.deepEqual(JSON.parse(question.rawContent!), user);
	for (const event of [system, context, question]) {
		assert.equal(event.span, request);
		assert.equal(event.marker, true);
		assert.ok(!event.rawContent!.includes("OLD_REPLY"));
	}
	assert.ok(!system.rawContent!.includes("USER_ONLY"));
	assert.ok(!system.rawContent!.includes(instructions));
	assert.equal(request.attributes["loom.io.input"], input);
	assert.equal(events.find((event) => event.kind === "assistant")!.rawContent, undefined);

	request.attributes["loom.io.input"] = JSON.stringify([{ role: "system", content: [{ type: "text", text: "LEGACY_SYSTEM" }] }, { role: "user", content: "USER_ONLY" }]);
	assert.deepEqual(JSON.parse(traceTurns([row])[0]!.events.find((event) => event.kind === "system")!.rawContent!), [{ type: "text", text: "LEGACY_SYSTEM" }]);
});

test("system tool lists replay captured additions, removals and replacements without reading other message roles", () => {
	const bash = { name: "bash", description: "RUN_COMMAND", parameters: { type: "object", properties: { command: { type: "string" } } } };
	const read = { name: "read", description: "READ_FILE", parameters: { type: "object" } };
	const messages: JsonValue[] = [
		{ role: "system", content: "SYSTEM_ONLY", toolsAdded: [{ ...bash, description: "OLD_DESCRIPTION" }, { name: "removed" }] },
		{ role: "user", content: "USER_ONLY", toolsAdded: [{ name: "not-a-system-tool" }] },
		{ role: "system", toolsRemoved: [{ name: "removed" }, { name: "bash" }], toolsAdded: [read, bash] },
	];
	const result = capturedTools(messages);
	assert.deepEqual(result, { definitions: [read, bash], captured: true, incomplete: false });
	assert.equal(result.definitions[1], bash);
	const source = record("tools");
	source.spans[2] = { ...source.spans[2]!, attributes: { "loom.io.input": JSON.stringify(messages) } };
	const system = traceTurns([source])[0]!.events.find((event) => event.kind === "system")!;
	assert.equal(system.text, "SYSTEM_ONLY");
	assert.equal(JSON.parse(system.rawContent!), "SYSTEM_ONLY");
	assert.deepEqual(system.toolList, result);
	assert.ok(!JSON.stringify(system.toolList).includes("USER_ONLY"));
	assert.ok(!JSON.stringify(system.toolList).includes("OLD_DESCRIPTION"));
	assert.ok(!JSON.stringify(system.toolList).includes("not-a-system-tool"));

	source.spans[2] = { ...source.spans[2]!, attributes: { "loom.io.input": JSON.stringify([{ role: "system", toolsAdded: [bash] }]) } };
	const toolsOnly = traceTurns([source])[0]!.events.find((event) => event.kind === "system")!;
	assert.equal(toolsOnly.text, undefined);
	assert.equal(toolsOnly.rawContent, undefined);
	assert.deepEqual(toolsOnly.toolList!.definitions, [bash]);
});

test("only confirmed tool-definition omissions trigger the incomplete warning", () => {
	assert.deepEqual(capturedTools(undefined), { definitions: [], captured: false, incomplete: false });
	assert.deepEqual(capturedTools([{ role: "system", content: "SYSTEM" }]), { definitions: [], captured: false, incomplete: false });
	assert.deepEqual(capturedTools([{ role: "system", toolsAdded: [] }]), { definitions: [], captured: true, incomplete: false });
	const tool = { name: "bash", description: "preview… ⟦blob:0123456789abcdef:1000⟧", parameters: { "… (trace omitted)": "… (trace content omitted)" } };
	assert.deepEqual(capturedTools(["… 3 earlier messages omitted", { role: "system", toolsAdded: [tool, "… (1 items omitted)"] }]), { definitions: [tool], captured: true, incomplete: true });
	assert.deepEqual(capturedTools([{ role: "system", toolsAdded: "[omitted]" }]), { definitions: [], captured: true, incomplete: true });
	assert.deepEqual(capturedTools([{ role: "system", toolsRemoved: [{ name: "unknown" }] }]).definitions, []);
	const complete = { name: "bash", description: "Explains bytes cut and trace content omitted, without being clipped.", parameters: { type: "object" } };
	const unrelatedOmissions: JsonValue[] = ["… 3 earlier messages omitted", { role: "system", content: "PROMPT\n… (42 bytes cut)", sections: { instructions: "[omitted]" }, toolsAdded: [complete] }];
	assert.deepEqual(capturedTools(unrelatedOmissions), { definitions: [complete], captured: true, incomplete: false });
	assert.equal(capturedTools([{ role: "system", toolsAdded: [{ ...complete, description: "Partial\n… (42 of 100 bytes cut)" }] }]).incomplete, true);
	assert.equal(capturedTools([{ role: "system", toolsAdded: [tool] }, { role: "system", toolsAdded: [complete] }]).incomplete, false);
	assert.equal(capturedTools([{ role: "system", toolsAdded: [tool] }, { role: "system", toolsRemoved: [{ name: "bash" }] }]).incomplete, false);
});

test("independent tool snapshots override clipped legacy copies, including empty registries and missing blobs", () => {
	const row = record("snapshot-tools");
	const complete = [{ name: "update_settings", description: "full description", parameters: { type: "object", properties: { headers: { type: "object" }, apiKey: { type: "string" } } } }];
	const request = row.spans[2]!;
	request.attributes["loom.io.tools"] = JSON.stringify(complete);
	request.attributes["loom.io.input"] = JSON.stringify([{ role: "system", content: "PROMPT", toolsAdded: [{ name: "update_settings", parameters: "[omitted]" }, "… (10 items omitted)"] }]);
	assert.deepEqual(traceTurns([row])[0]!.events.find((event) => event.kind === "system")!.toolList, { definitions: complete, captured: true, incomplete: false });
	assert.deepEqual(capturedTools(undefined, "[]"), { definitions: [], captured: true, incomplete: false });
	assert.deepEqual(capturedTools(undefined, "invalid"), { definitions: [], captured: true, incomplete: true });
	assert.equal(capturedTools(undefined, '["… (trace content omitted)"]').incomplete, true);
	const reference = [{ ...complete[0]!, description: "preview… ⟦blob:0123456789abcdef:1000⟧" }];
	assert.equal(capturedTools(undefined, JSON.stringify(reference)).incomplete, true);
	assert.equal(capturedTools(undefined, JSON.stringify(reference), { "0123456789abcdef": "FULL_DESCRIPTION" }).incomplete, false);
	assert.equal(capturedTools(undefined, JSON.stringify(reference), { "0123456789abcdef": "PARTIAL\n… (42 bytes cut)" }).incomplete, true);
	request.attributes["loom.io.input"] = '"… (trace content omitted)"';
	const toolsOnly = traceTurns([row])[0]!.events.find((event) => event.kind === "system")!;
	assert.equal(toolsOnly.text, undefined);
	assert.deepEqual(toolsOnly.toolList!.definitions, complete);
	delete request.attributes["loom.io.tools"];
	assert.equal(traceTurns([row])[0]!.events.some((event) => event.kind === "system"), false);
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
	const equal = timelineLayout(events, false, 300, 1000).blocks;
	assert.equal(equal[0]!.width, .25); assert.equal(equal[1]!.left, .25);
	const actual = timelineLayout(events, true, 300, 1000).blocks;
	assert.equal(actual[0]!.width, 0); assert.equal(actual[1]!.width, 0);
	assert.equal(actual[2]!.left, actual[3]!.left);
	assert.equal(actual[2]!.width, .988); assert.equal(actual[2]!.lane, 1); assert.equal(actual[3]!.lane, 2);
	const running = events.map((event) => event.kind === "assistant" ? { ...event, span: { ...event.span, endedMs: undefined, events: [{ name: "pi.ai.first_chunk", timeMs: 50, attributes: {} }] } } : event);
	const blocks = timelineLayout(running, true, 300, 1000).blocks;
	assert.equal(blocks[2]!.firstChunk, .25); assert.equal(blocks[2]!.width, .988);
	assert.deepEqual(timelineLayout([], true, 0, 1000), { blocks: [], gaps: [] });
});

test("a cancelled request phase folds into the model request it wrapped, so one call is one event", () => {
	const phase = span("wrap", "pi.durable.phase", { "task.name": "pi.generation", phase: "request", attempt: 3, outcome: "aborted" }, "submit");
	const request = span("req", "pi.ai.request", { model: "demo", "loom.io.output": JSON.stringify([{ type: "text", text: "partial reply" }]) }, "wrap");
	const bare = span("req-bare", "pi.ai.request", { model: "demo" }, "wrap-bare");
	const wrapBare = span("wrap-bare", "pi.durable.phase", { "task.name": "pi.generation", phase: "request", attempt: 4, outcome: "aborted" }, "submit");
	const tail = span("tail", "pi.durable.phase", { "task.name": "pi.generation", phase: "request", attempt: 4, outcome: "aborted" }, "submit");
	const ordinary = span("ok", "pi.ai.request", { model: "demo" }, "other");
	const turn = traceTurns([{ ...record("cancel"), spans: [span("submit", "pi.durable.submit", { "submission.type": "input" }), phase, request, wrapBare, bare, tail, ordinary] }])[0]!;
	const kinds = turn.events.filter((event) => !event.marker).map((event) => `${event.kind}:${event.span.id}`);
	assert.deepEqual(kinds, ["assistant:req", "assistant:req-bare", "phase:tail", "assistant:ok"], "wrapping phases are gone; a phase with no request under it stays");
	const byId = (id: string) => turn.events.find((event) => event.span.id === id)!;
	assert.equal(eventStatus(byId("req")), "interrupted");
	assert.equal(byId("req").cancelled, true);
	assert.match(byId("req").summary, /partial reply/);
	assert.equal(byId("req-bare").summary, "已取消，无已采集输出");
	assert.equal(eventStatus(byId("ok")), "completed", "a request that was not cancelled is unchanged");
	assert.equal(eventForSpan([turn], "wrap"), undefined, "the folded phase has no row of its own; its record stays in the native spans");
	assert.equal(turn.record.spans.length, 7, "stored spans are untouched");
});
