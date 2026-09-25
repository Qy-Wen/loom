import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChatMessages, toAgUiMessages, transcriptText } from "../src/shared/ag-ui-messages.ts";
import { isChatErrorMessageId } from "../src/shared/chat-error.ts";

test("toAgUiMessages maps user/assistant/toolResult and skips unknown roles", () => {
	const messages = toAgUiMessages([
		{
			role: "user",
			content: "hello",
			attachments: [{ type: "ui_selection", assetId: "a", path: "clips/hero.mp4", assetType: "video" }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "hi " },
				{ type: "text", text: "there" },
				{ type: "toolCall", id: "call-1", name: "search_assets", arguments: { query: "x" } },
			],
		},
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
	const assistant = messages[1];
	assert.ok(assistant && assistant.role === "assistant");
	assert.deepEqual(assistant.role === "assistant" ? assistant.toolCalls : undefined, [
		{ id: "call-1", type: "function", function: { name: "search_assets", arguments: "{\"query\":\"x\"}" } },
	]);
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

test("chat error message ids are distinct from model replies", () => {
	assert.equal(isChatErrorMessageId("loom-error-1"), true);
	assert.equal(isChatErrorMessageId("msg-1"), false);
	assert.equal(isChatErrorMessageId(undefined), false);
});
