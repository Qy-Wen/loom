import assert from "node:assert/strict";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryId, EntryRecord, LiveState, TranscriptView } from "@loom/agent";
import { createAgUiEvents } from "../src/main/chat/ag-ui-events.ts";

const view = (entries: EntryRecord[] = [], live: LiveState = {}, id = 1): TranscriptView => ({
	conversation: { id: id as ConversationId }, docs: { "pi.live": live }, items: entries.map((entry) => ({ kind: "entry", entry })),
});

test("interleaved partial blocks emit each delta once and adopt the committed entry", async () => {
	const output: Array<Record<string, unknown>> = [];
	const presenter = createAgUiEvents((event) => output.push(event as Record<string, unknown>), { threadId: "1", submit: true, replay: false, watchChild: async () => {} });
	await presenter.onView(view());
	const { diagnostics: _diagnostics, deferred: _deferred, ...message } = fauxAssistantMessage("");
	await presenter.onView(view([], { generation: { attempt: 1, message: { ...message, content: [{ type: "thinking", thinking: "Reason" }, { type: "text", text: "Hello" }] } } }));
	const partial = view([], { generation: { attempt: 1, message: { ...message, content: [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Hello world" }, { type: "thinking", thinking: "private", redacted: true }] } } });
	await presenter.onView(partial);
	await presenter.onView(partial);
	await presenter.onView(view([{
		id: 9 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant",
		model: [{ ...message, content: [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Hello world!" }] }],
	}]));
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
	await presenter.onView(view());
	await presenter.onView(view([], { tools: [{ callId: "same", name: "read", status: "running", details: { conversationId: 2 } }] }));
	const child = view([], { tools: [{ callId: "same", name: "read", status: "running" }] }, 2);
	await presenter.onChildView(2, child);
	await presenter.onChildView(2, child);
	await presenter.onChildView(2, view([{
		id: 7 as EntryId, conversationId: 2 as ConversationId, kind: "pi.toolResult",
		model: [{ role: "toolResult", toolCallId: "same", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "bytes-stay-in-storage" }], isError: false, timestamp: 1 }],
	}], {}, 2));
	assert.deepEqual(children, [2]);
	assert.deepEqual(output.filter((event) => event.type === EventType.TOOL_CALL_START).map((event) => event.toolCallId), ["1/same", "2/same"]);
	const result = output.find((event) => event.type === EventType.TOOL_CALL_RESULT)!;
	assert.equal(result.toolCallId, "2/same");
	assert.ok(String(result.content).includes("loom-asset://chat-image/2/7/0"));
	assert.ok(!String(result.content).includes("bytes-stay-in-storage"));
});

test("a coalesced view preserves completed tool rounds and separate assistant message IDs", async () => {
	const output: Array<Record<string, unknown>> = [];
	const presenter = createAgUiEvents((event) => output.push(event as Record<string, unknown>), { threadId: "1", submit: true, replay: false, watchChild: async () => {} });
	await presenter.onView(view());
	const entries: EntryRecord[] = [
		{ id: 2 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [fauxAssistantMessage([{ type: "text", text: "Checking" }, { type: "toolCall", id: "read", name: "read", arguments: {} }])] },
		{ id: 3 as EntryId, conversationId: 1 as ConversationId, kind: "pi.toolResult", model: [{ role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "found" }], timestamp: 1, isError: false }] },
		{ id: 4 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [fauxAssistantMessage("Done")] },
	];
	await presenter.onView(view(entries));
	await presenter.onView(view(entries));
	assert.equal(output.filter((event) => event.type === EventType.TOOL_CALL_RESULT).length, 1);
	assert.equal(output.find((event) => event.type === EventType.TOOL_CALL_RESULT)?.content, "found");
	const starts = output.filter((event) => event.type === EventType.TEXT_MESSAGE_START);
	assert.equal(starts.length, 2);
	assert.notEqual(starts[0]?.messageId, starts[1]?.messageId);
});
