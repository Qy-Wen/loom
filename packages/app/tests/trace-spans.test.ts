import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoomTraceSpan } from "@loom/agent";
import { formatTraceDuration, formatTraceTimestamp, spanPayload, visibleSpans } from "../src/renderer/dev-trace/trace-spans.ts";

function span(partial: Pick<LoomTraceSpan, "id" | "parentId" | "name"> & Partial<LoomTraceSpan>): LoomTraceSpan {
	return {
		traceId: "trace", events: [], links: [], attributes: {},
		status: { status: "ok" },
		startedMs: 1_000,
		endedMs: 1_400,
		...partial,
	};
}

describe("trace spans", () => {
	it("filters ledger candidates without cloning or rewriting native parents", () => {
		const spans = [
			span({ id: "1", parentId: undefined, name: "pi.durable.submit" }),
			span({ id: "2", parentId: "1", name: "pi.harness.hook" }),
			span({ id: "3", parentId: "2", name: "pi.durable.phase", attributes: { "task.name": "pi.tool", "phase": "call", "tool.name": "read" } }),
			span({ id: "4", parentId: "absent", name: "pi.ai.request" }),
		];
		const visible = visibleSpans(spans);
		assert.deepEqual(visible.map((item) => item.id), ["1", "3", "4"]);
		assert.equal(visible[1], spans[2]);
		assert.equal(visible[1]?.parentId, "2");
		assert.equal(visible[2], spans[3]);
		assert.equal(visible[2]?.parentId, "absent");
	});

	it("formats milliseconds and seconds without negative durations", () => {
		assert.equal(formatTraceDuration(-1), "0ms");
		assert.equal(formatTraceDuration(123.5), "124ms");
		assert.equal(formatTraceDuration(1500), "1.5s");
		assert.equal(formatTraceDuration(12000), "12s");
	});

	it("formats native timestamps in local time down to milliseconds without changing the source", () => {
		const date = new Date(2026, 9, 30, 8, 9, 7, 5);
		const timestamp = date.getTime() + 0.75;
		assert.equal(formatTraceTimestamp(timestamp), "2026-10-30 08:09:07.005");
		assert.equal(timestamp, date.getTime() + 0.75);
		assert.equal(formatTraceTimestamp(new Date(2026, 11, 31, 23, 59, 59, 999).getTime()), "2026-12-31 23:59:59.999");
		for (const missing of [undefined, NaN, Infinity, -Infinity, 9e15]) assert.equal(formatTraceTimestamp(missing), "未采集");
	});

	it("reads captured string payloads and ignores absent or non-string values", () => {
		assert.equal(spanPayload(span({ id: "1", parentId: undefined, name: "pi.durable.submit" })), null);
		assert.deepEqual(
			spanPayload(span({
				id: "2",
				parentId: "1",
				name: "pi.durable.phase",
				attributes: { "loom.io.input": "{\"path\":\"a.md\"}", "loom.io.output": "ok" },
			})),
			{ input: "{\"path\":\"a.md\"}", output: "ok" },
		);
		assert.equal(spanPayload(span({ id: "3", parentId: undefined, name: "pi.ai.request", attributes: { "loom.io.input": 42 } })), null);
	});
});
