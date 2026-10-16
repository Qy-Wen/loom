import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptMessageId, liveMessagesForSession, mergeChatMessages, toAgUiMessages, transcriptText } from "../src/shared/ag-ui-messages.ts";
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

test("toAgUiMessages shows user text and skips an image part", () => {
	const messages = toAgUiMessages([
		{
			id: "u1",
			role: "user",
			content: [{ type: "text", text: "look" }, { type: "image", data: "abc", mimeType: "image/png" }],
		},
	]);
	assert.equal(messages[0]?.content, "look");
	const live = [{ id: "u1", role: "user" as const, content: "look" }, { id: "a1", role: "assistant" as const, content: "ok" }];
	const merged = mergeChatMessages(messages, live);
	assert.equal(merged[0]?.content, "look");
	assert.equal(merged[1]?.content, "ok");
});

test("live messages from another session stay hidden", () => {
	const previous = [{ id: "u-old", role: "user" as const, content: "old question" }];
	const next = [{ id: "u-new", role: "user" as const, content: "new question" }];
	assert.deepEqual(liveMessagesForSession("session-b", "session-a", previous, null), []);
	assert.deepEqual(liveMessagesForSession("session-b", "session-b", previous, previous), []);
	assert.deepEqual(liveMessagesForSession("session-b", "session-b", next, previous), next);
	assert.deepEqual(liveMessagesForSession("", "session-b", next, null), []);
});

test("committed history and live increments merge by stable ID", () => {
	const stored = toAgUiMessages([
		{ id: "u0", role: "user", content: "first" },
		{ id: "a0", role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "text", text: "answer" }] },
		{ id: "u1", role: "user", content: "next" },
	]);
	const live = [...stored, { id: "live-thinking", role: "reasoning" as const, content: "thinking" }, { id: "live-answer", role: "assistant" as const, content: "partial" }];
	assert.deepEqual(mergeChatMessages(stored, []), stored);
	assert.deepEqual(mergeChatMessages(stored, stored), stored);
	assert.deepEqual(mergeChatMessages(stored, live), [...stored, ...live.slice(stored.length)]);
	const adopted = adoptMessageId(live, "live-answer", "a1")!;
	const complete = [...stored, { id: "a1", role: "assistant" as const, content: "complete" }];
	assert.equal(mergeChatMessages(complete, adopted).find((message) => message.id === "a1")?.content, "complete");
});

test("admission before its stream event replaces only the matching optimistic user", () => {
	const stored = toAgUiMessages([{ id: "saved", role: "user", content: "question", clientMessageId: "optimistic" }]);
	const live = [{ id: "optimistic", role: "user" as const, content: "question" }, { id: "different", role: "user" as const, content: "question" }];
	assert.deepEqual(mergeChatMessages(stored, live).map((message) => message.id), ["saved", "different"]);
});

test("live specialist calls remain visible alongside their committed parent", () => {
	const parent = { id: "a", role: "assistant" as const, content: "delegating", toolCalls: [{ id: "parent", type: "function" as const, function: { name: "run_create_agent", arguments: "{}" } }] };
	const child = { id: "child", type: "function" as const, function: { name: "write", arguments: '{"path":"output.txt"}' } };
	const merged = mergeChatMessages([parent], [{ ...parent, content: "", toolCalls: [...parent.toolCalls, child] }]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0]?.content, "delegating");
	assert.deepEqual(merged[0]?.role === "assistant" ? merged[0].toolCalls : [], [...parent.toolCalls, child]);
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

test("adoption renames both answer and reasoning without touching other rows", () => {
	const live = [{ id: "temporary-thinking", role: "reasoning" as const, content: "thinking" }, { id: "temporary", role: "assistant" as const, content: "answer" }, { id: "user", role: "user" as const, content: "same text" }];
	const adopted = adoptMessageId(live, "temporary", "saved")!;
	assert.deepEqual(adopted.map((message) => message.id), ["saved-thinking", "saved", "user"]);
	assert.equal(adoptMessageId(adopted, "missing", "other"), null);
});

test("chat error message ids are distinct from model replies", () => {
	assert.equal(isChatErrorMessageId("loom-error-1"), true);
	assert.equal(isChatErrorMessageId("msg-1"), false);
	assert.equal(isChatErrorMessageId(undefined), false);
	assert.match(formatChatError("fetch failed"), /Could not reach the Chat endpoint/);
	assert.match(formatChatError("401 Unauthorized"), /API key was rejected/);
});
