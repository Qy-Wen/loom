import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoomTraceSpan } from "@loom/agent";
import { spanPayload, toSpanData, traceSummary, visibleSpans } from "../src/renderer/dev-trace/trace-spans.ts";

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
	it("drops hook spans and reparents the tool onto the run", () => {
		const spans = [
			span({ id: "1", parentId: undefined, name: "pi.durable.submit" }),
			span({ id: "2", parentId: "1", name: "pi.harness.hook" }),
			span({ id: "3", parentId: "2", name: "pi.durable.phase", attributes: { "task.name": "pi.tool", "phase": "call", "tool.name": "read" } }),
		];
		const visible = visibleSpans(spans);
		assert.deepEqual(visible.map((item) => item.name), ["pi.durable.submit", "pi.durable.phase"]);
		assert.equal(visible[1]?.parentId, "1");
		const data = toSpanData(spans);
		assert.equal(data[1]?.name, "read · call");
		assert.equal(data[1]?.type, "tool");
		assert.equal(data[1]?.parentSpanId, "1");
		assert.equal(data[1]?.latencyMs, 400);
	});

	it("summarizes duration, tokens, and tool names", () => {
		const summary = traceSummary([
			span({ id: "1", parentId: undefined, name: "pi.durable.submit", startedMs: 0, endedMs: 1500 }),
			span({
				id: "2",
				parentId: "1",
				name: "pi.ai.request",
				attributes: { "model": "gpt", "usage.input": 20, "usage.output": 5 },
			}),
			span({ id: "3", parentId: "1", name: "pi.durable.phase", attributes: { "tool.name": "write" } }),
			span({ id: "4", parentId: "1", name: "pi.harness.hook" }),
		]);
		assert.equal(summary, "1.5s · 20 in / 5 out · write");
	});

	it("reads a span payload and ignores spans without one", () => {
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
	});
});
