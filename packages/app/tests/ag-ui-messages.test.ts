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

test("toAgUiMessages shows thinking and drops redacted text and signatures", () => {
	const messages = toAgUiMessages([
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "visible", thinkingSignature: "sig" },
				{ type: "thinking", thinking: "secret", redacted: true, thinkingSignature: "opaque" },
				{ type: "text", text: "answer" },
			],
		},
	]);
	assert.deepEqual(
		messages.map((message) => ({ role: message.role, content: "content" in message ? message.content : "" })),
		[
			{ role: "reasoning", content: "visible" },
			{ role: "assistant", content: "answer" },
		],
	);
	assert.equal(JSON.stringify(messages).includes("sig"), false);
	assert.equal(JSON.stringify(messages).includes("opaque"), false);
	assert.equal(JSON.stringify(messages).includes("secret"), false);
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
	const branched = [
		{ id: "u1", role: "user" as const, content: "old" },
		{ id: "a2", role: "assistant" as const, content: "other reply" },
	];
	const stale = [
		{ id: "u1", role: "user" as const, content: "old" },
		{ id: "a1", role: "assistant" as const, content: "reply" },
	];
	assert.equal(mergeChatMessages(branched, stale)[1]?.id, "a2");
});

test("chat error message ids are distinct from model replies", () => {
	assert.equal(isChatErrorMessageId("loom-error-1"), true);
	assert.equal(isChatErrorMessageId("msg-1"), false);
	assert.equal(isChatErrorMessageId(undefined), false);
});
