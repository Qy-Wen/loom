import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChatMessages, toAgUiMessages, transcriptText } from "../src/shared/ag-ui-messages.ts";

test("toAgUiMessages maps user/assistant/toolResult and skips unknown roles", () => {
	const messages = toAgUiMessages([
		{ role: "user", content: "hello" },
		{ role: "assistant", content: [{ type: "text", text: "hi " }, { type: "text", text: "there" }] },
		{ role: "toolResult", toolCallId: "call-1", content: "ok" },
		{ role: "system", content: "ignore" },
	]);
	assert.deepEqual(
		messages.map((message) => ({ role: message.role, content: "content" in message ? message.content : "" })),
		[
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
			{ role: "tool", content: "ok" },
		],
	);
	assert.equal(transcriptText([{ type: "text", text: "a" }]), "a");
});

test("mergeChatMessages keeps stored history when live is empty and appends new turns", () => {
	const stored = toAgUiMessages([
		{ role: "user", content: "old" },
		{ role: "assistant", content: "reply" },
	]);
	assert.equal(mergeChatMessages(stored, []).length, 2);
	const live = [
		{ id: "n1", role: "user" as const, content: "new" },
		{ id: "n2", role: "assistant" as const, content: "ok" },
	];
	assert.deepEqual(
		mergeChatMessages(stored, live).map((message) => ("content" in message ? message.content : "")),
		["old", "reply", "new", "ok"],
	);
	assert.equal(mergeChatMessages(stored, stored).length, 2);
});
