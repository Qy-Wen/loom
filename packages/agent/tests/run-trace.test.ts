import assert from "node:assert/strict";
import { test } from "node:test";
import { LoomTelemetryContext } from "../src/run-trace.ts";

test("records nested spans with start and end times", async () => {
	const trace = new LoomTelemetryContext();
	await trace.startSpan({ name: "pi.harness.run" }, async (run) => {
		await run.startSpan({ name: "pi.harness.tool", attributes: { "pi.tool.name": "read" } }, async (tool) => {
			tool.setAttributes({ "pi.tool.is_error": false });
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	});
	const spans = trace.getSpans();
	assert.equal(spans.length, 2);
	assert.equal(spans[0]?.name, "pi.harness.run");
	assert.equal(spans[0]?.parentId, null);
	assert.equal(spans[1]?.name, "pi.harness.tool");
	assert.equal(spans[1]?.parentId, spans[0]?.id);
	assert.equal(spans[1]?.attributes["pi.tool.name"], "read");
	assert.equal(spans[1]?.attributes["pi.tool.is_error"], false);
	assert.ok(spans[0] && spans[1]);
	assert.ok(spans[0].endedAt !== undefined && spans[0].endedAt >= spans[0].startedAt);
	assert.ok(spans[1].endedAt !== undefined && spans[1].endedAt >= spans[1].startedAt);
	assert.ok(spans[0].endedAt >= spans[1].endedAt);
});

test("marks a thrown span as an error", async () => {
	const trace = new LoomTelemetryContext();
	await assert.rejects(trace.startSpan({ name: "pi.ai.request" }, () => {
		throw new Error("provider down");
	}));
	const span = trace.getSpans()[0];
	assert.equal(span?.status.status, "error");
	assert.ok(span?.endedAt !== undefined);
});
