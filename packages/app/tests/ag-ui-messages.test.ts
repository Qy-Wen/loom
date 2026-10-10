import assert from "node:assert/strict";
import { test } from "node:test";
import { adoptMessageId, adoptUserEntryId, freshUserTurn, liveMessagesForSession, mergeChatMessages, toAgUiMessages, transcriptText } from "../src/shared/ag-ui-messages.ts";
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

test("mergeChatMessages treats spacing around a chip as the same turn", () => {
	const block = "<asset_ref>\npath: clips/hero.png\nasset_id: asset-1\ntype: image\n</asset_ref>";
	const stored = toAgUiMessages([
		{ role: "user", content: `${block}\n\n这是啥` },
		{ role: "assistant", content: "一只金毛" },
	]);
	const live = [
		{ id: "ck-1", role: "user" as const, content: `\n\n${block}\n\n这是啥` },
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

test("a saved user entry id replaces the on-screen id and is visible as a new turn", () => {
	const previous = [
		{ id: "old-user", role: "user" as const, content: "first" },
		{ id: "old-assistant", role: "assistant" as const, content: "reply" },
	];
	const before = new Set(previous.map((message) => message.id));
	assert.equal(freshUserTurn(previous, before), false);
	const adopted = adoptUserEntryId([
		...previous,
		{ id: "local-user", role: "user", content: "edited" },
	], "0192a1c0-7b3e-7c21-8d10-0a1b2c3d4e5f");
	assert.equal(adopted?.[adopted.length - 1]?.id, "0192a1c0-7b3e-7c21-8d10-0a1b2c3d4e5f");
	assert.equal(adoptUserEntryId(adopted ?? [], "0192a1c0-7b3e-7c21-8d10-0a1b2c3d4e5f"), null);
	const renamed = adoptMessageId([
		{ id: "msg-1", role: "assistant", content: "hello" },
		{ id: "tool-result-1", role: "tool", content: "ok", toolCallId: "call-1" },
	], "tool-result-1", "0192a1c0-7b42-7abc-8000-abcdef012345");
	assert.equal(renamed?.[1]?.id, "0192a1c0-7b42-7abc-8000-abcdef012345");
	assert.equal(renamed?.[0]?.id, "msg-1");
	assert.equal(adoptMessageId(renamed ?? [], "missing", "0192a1c0-7b42-7abc-8000-abcdef012345"), null);
	assert.equal(freshUserTurn(adopted ?? [], before), true);
});

test("chat error message ids are distinct from model replies", () => {
	assert.equal(isChatErrorMessageId("loom-error-1"), true);
	assert.equal(isChatErrorMessageId("msg-1"), false);
	assert.equal(isChatErrorMessageId(undefined), false);
	assert.match(formatChatError("fetch failed"), /Could not reach the Chat endpoint/);
	assert.match(formatChatError("401 Unauthorized"), /API key was rejected/);
});
