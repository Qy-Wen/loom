import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeChatMessages, toAgUiMessages, transcriptText } from "../src/shared/ag-ui-messages.ts";
import { formatChatError, isChatErrorMessageId } from "../src/shared/chat-error.ts";

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

test("toAgUiMessages shows a composer image on the user bubble", () => {
	const messages = toAgUiMessages([
		{
			id: "u1",
			role: "user",
			content: [{ type: "text", text: "look" }, { type: "image", data: "abc", mimeType: "image/png" }],
		},
	]);
	assert.deepEqual(messages[0]?.content, [
		{ type: "text", text: "look" },
		{ type: "image", source: { type: "data", value: "abc", mimeType: "image/png" } },
	]);
	const stored = messages;
	const live = [{ id: "u1", role: "user" as const, content: "look" }, { id: "a1", role: "assistant" as const, content: "ok" }];
	const merged = mergeChatMessages(stored, live);
	assert.deepEqual(merged[0]?.content, stored[0]?.content);
	assert.equal(merged[1]?.content, "ok");
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
	const reloaded = [{ id: "entry-1", role: "user" as const, content: "bicycles" }];
	const streaming = [
		{ id: "ck-1", role: "user" as const, content: "bicycles" },
		{ id: "ck-2", role: "assistant" as const, content: "looking" },
	];
	assert.equal(mergeChatMessages(reloaded, streaming).at(-1)?.content, "looking");
});

test("mergeChatMessages treats a stored asset block and the composer marker as one turn", () => {
	const stored = toAgUiMessages([
		{
			role: "user",
			content: "<asset_ref>\npath: clips/hero.png\nasset_id: asset-1\ntype: image\n</asset_ref>\n\n这是啥",
		},
		{ role: "assistant", content: "一只金毛" },
	]);
	const live = [
		{ id: "ck-1", role: "user" as const, content: "\u2060loom-asset:asset-1\u2060这是啥" },
		{ id: "ck-2", role: "assistant" as const, content: "一只金毛" },
	];
	const merged = mergeChatMessages(stored, live);
	assert.equal(merged.length, 2);
	assert.match(String(merged[0] && "content" in merged[0] ? merged[0].content : ""), /<asset_ref>/);
	assert.equal(merged[1] && "content" in merged[1] ? merged[1].content : "", "一只金毛");
});

test("toAgUiMessages collapses offline retry attempts into one request failure", () => {
	const messages = toAgUiMessages([
		{ id: "u1", role: "user", content: "你好" },
		{ id: "a1", role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" },
		{ id: "a2", role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" },
		{ id: "a3", role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" },
		{ id: "a4", role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" },
	]);
	assert.equal(messages.length, 2);
	assert.equal(messages[1]?.id, "loom-error-a4");
	assert.match(String(messages[1] && "content" in messages[1] ? messages[1].content : ""), /Could not reach the Chat endpoint/);
	assert.equal(isChatErrorMessageId(messages[1]?.id), true);
});

test("toAgUiMessages drops failed attempts once a reply arrives", () => {
	const messages = toAgUiMessages([
		{ id: "u1", role: "user", content: "你好" },
		{ id: "a1", role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed" },
		{ id: "a2", role: "assistant", content: [{ type: "text", text: "在的" }], stopReason: "stop" },
		{ id: "u2", role: "user", content: "停" },
		{ id: "a3", role: "assistant", content: [], stopReason: "aborted" },
	]);
	assert.deepEqual(
		messages.map((message) => ("content" in message ? message.content : "")),
		["你好", "在的", "停"],
	);
});

test("chat error message ids are distinct from model replies", () => {
	assert.equal(isChatErrorMessageId("loom-error-1"), true);
	assert.equal(isChatErrorMessageId("msg-1"), false);
	assert.equal(isChatErrorMessageId(undefined), false);
	assert.match(formatChatError("fetch failed"), /Could not reach the Chat endpoint/);
	assert.match(formatChatError("401 Unauthorized"), /API key was rejected/);
});
