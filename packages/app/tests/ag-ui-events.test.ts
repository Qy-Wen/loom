import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId } from "@loom/agent";
import { createAgUiEvents } from "../src/main/ag-ui-events.ts";

test("interleaved partial blocks emit each delta once and adopt the committed entry", async () => {
	const output: Array<Record<string, unknown>> = [];
	const presenter = createAgUiEvents((event) => output.push(event as Record<string, unknown>), { threadId: "1", submit: true, replay: false, watchChild: async () => {} });
	const message = fauxAssistantMessage("");
	await presenter.onEvent({ type: "message_start", message: { ...message, content: [] } });
	await presenter.onEvent({ type: "message_update", usage: message.usage, changes: [
		{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "Reason" } },
		{ type: "text_start", contentIndex: 1, block: { type: "text", text: "Hello" } },
	] });
	await presenter.onEvent({ type: "message_update", usage: message.usage, changes: [
		{ type: "thinking_delta", contentIndex: 0, delta: "ing" },
		{ type: "text_delta", contentIndex: 1, delta: " world" },
		{ type: "block", contentIndex: 2, block: { type: "thinking", thinking: "private", redacted: true } },
	] });
	await presenter.onEvent({ type: "message_end", entry: {
		id: 9 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant",
		model: [{ ...message, content: [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Hello world!" }] }],
	} });
	assert.equal(output.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => event.delta).join(""), "Hello world!");
	assert.equal(output.filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT).map((event) => event.delta).join(""), "Reasoning");
	assert.equal(output.filter((event) => event.type === EventType.TEXT_MESSAGE_END).length, 1);
	assert.equal(output.at(-1)?.name, "loom.adopt_entry");
	assert.equal((output.at(-1)?.value as { entryId: string }).entryId, "9");
});

test("parent and child calls keep distinct IDs, deduplicate starts, and publish image references", async () => {
	const output: Array<Record<string, unknown>> = [];
	const children: number[] = [];
	const presenter = createAgUiEvents((event) => output.push(event as Record<string, unknown>), { threadId: "1", submit: true, replay: false, watchChild: async (id) => { children.push(id); } });
	await presenter.onEvent({ type: "tool_execution_start", toolCallId: "same", toolName: "read", args: {} });
	await presenter.onEvent({ type: "tool_execution_update", toolCallId: "same", toolName: "read", details: { conversationId: 2 } });
	await presenter.onChildEvent(2, { type: "tool_execution_start", toolCallId: "same", toolName: "read", args: {} });
	await presenter.onChildEvent(2, { type: "tool_execution_start", toolCallId: "same", toolName: "read", args: {} });
	await presenter.onChildEvent(2, { type: "tool_execution_end", toolCallId: "same", toolName: "read", entry: {
		id: 7 as EntryId, conversationId: 2 as ConversationId, kind: "pi.toolResult",
		model: [{ role: "toolResult", toolCallId: "same", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "bytes-stay-in-storage" }], isError: false, timestamp: 1 }],
	} });
	assert.deepEqual(children, [2]);
	assert.deepEqual(output.filter((event) => event.type === EventType.TOOL_CALL_START).map((event) => event.toolCallId), ["1/same", "2/same"]);
	const result = output.find((event) => event.type === EventType.TOOL_CALL_RESULT)!;
	assert.equal(result.toolCallId, "2/same");
	assert.ok(String(result.content).includes("loom-asset://chat-image/2/7/0"));
	assert.ok(!String(result.content).includes("bytes-stay-in-storage"));
});
