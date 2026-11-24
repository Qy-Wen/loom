import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message, ToolCall } from "@ag-ui/client";
import { transcriptItems } from "../src/transcript.ts";

test("pairs tool results by call ID without changing message order or hiding unmatched results", () => {
	const call: ToolCall = { id: "call", type: "function", function: { name: "lookup", arguments: "{}" } };
	const assistant: Message = { id: "agent", role: "assistant", content: "Looking up", toolCalls: [call] };
	const activity: Message = { id: "progress", role: "activity", activityType: "progress", content: {} };
	const result: Message = { id: "result", role: "tool", toolCallId: "call", content: "done" };
	const unmatched: Message = { id: "other", role: "tool", toolCallId: "previous-call", content: "from before the snapshot" };

	assert.deepEqual(transcriptItems([assistant, activity, result, unmatched]), [
		{ kind: "message", message: assistant },
		{ kind: "tool", call, result },
		{ kind: "message", message: activity },
		{ kind: "message", message: unmatched },
	]);
	assert.deepEqual(transcriptItems([assistant]).at(-1), { kind: "tool", call, result: undefined });
});
