import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachToolExchange, clipTraceText, TOOL_IO_LIMIT, toolArgsText } from "../src/trace-io.ts";
import type { LoomTraceSpan } from "../src/run-trace.ts";
import { formatAssistantReply, formatModelRequest } from "../vendor-pi-agent/src/harness/span-io.ts";

function span(partial: Pick<LoomTraceSpan, "id" | "name"> & Partial<LoomTraceSpan>): LoomTraceSpan {
	return {
		parentId: null,
		attributes: {},
		status: { status: "ok" },
		startedAt: 0,
		endedAt: 1,
		...partial,
	};
}

describe("trace io", () => {
	it("clips long text and keeps a short one", () => {
		assert.equal(clipTraceText("abc", 10), "abc");
		assert.equal(clipTraceText("abcdef", 3), "abc\n…");
	});

	it("attaches tool arguments and result by call id", () => {
		const spans = attachToolExchange(
			[
				span({ id: 1, name: "pi.harness.run" }),
				span({ id: 2, name: "pi.harness.tool", attributes: { "pi.tool.call_id": "call-1", "pi.tool.name": "read" } }),
			],
			new Map([["call-1", { args: toolArgsText({ path: "a.md" }), result: "hello" }]]),
		);
		assert.equal(spans[0]?.attributes["loom.io.input"], undefined);
		assert.equal(spans[1]?.attributes["loom.io.input"], '{\n  "path": "a.md"\n}');
		assert.equal(spans[1]?.attributes["loom.io.output"], "hello");
		assert.equal(spans[1]?.attributes["pi.tool.name"], "read");
	});

	it("caps tool arguments", () => {
		const text = toolArgsText({ body: "x".repeat(TOOL_IO_LIMIT) });
		assert.ok(text.endsWith("\n…"));
		assert.ok(text.length < TOOL_IO_LIMIT + 8);
	});

	it("formats a model request without image bytes and keeps the reply", () => {
		const request = formatModelRequest("be brief", [
			{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "file" }] },
		]);
		assert.match(request, /^system\nbe brief/);
		assert.match(request, /user\nlook\n\[image image\/png\]/);
		assert.equal(request.includes("AAAA"), false);
		assert.match(request, /toolResult read\nfile/);
		const reply = formatAssistantReply({
			content: [
				{ type: "thinking", thinking: "hmm", redacted: true },
				{ type: "text", text: "done" },
				{ type: "toolCall", name: "read", arguments: { path: "a.md" } },
			],
		});
		assert.equal(reply.includes("hmm"), false);
		assert.match(reply, /\[redacted thinking\]\ndone\nread \{"path":"a.md"\}/);
	});
});