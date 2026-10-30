import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@ag-ui/core";
import { turnEndReplyIds } from "../src/renderer/chat/chat-turns.ts";

const user = (id: string): Message => ({ id, role: "user", content: id });
const reply = (id: string, content = id): Message => ({ id, role: "assistant", content });
const toolCall = (id: string): Message => ({ id, role: "assistant", content: "", toolCalls: [{ id: `${id}-call`, type: "function", function: { name: "x", arguments: "{}" } }] });
const tool = (id: string): Message => ({ id, role: "tool", toolCallId: `${id}-call`, content: "ok" });

test("only the last text reply of each turn can start a branch", () => {
	const ids = turnEndReplyIds([user("u1"), toolCall("a1"), tool("t1"), reply("a2"), user("u2"), reply("a3")]);
	assert.deepEqual([...ids], ["a2", "a3"]);
});

test("a turn that stops on a tool call, a failure or an empty reply has no branch point", () => {
	assert.deepEqual([...turnEndReplyIds([user("u1"), toolCall("a1"), tool("t1")])], []);
	assert.deepEqual([...turnEndReplyIds([user("u1"), reply("loom-error-a1")])], []);
	assert.deepEqual([...turnEndReplyIds([user("u1"), reply("a1", "  ")])], []);
	assert.deepEqual([...turnEndReplyIds([user("u1"), reply("a1"), toolCall("a2"), tool("t2")])], []);
});

test("reasoning rows do not hide the reply and the first turn may have no user row", () => {
	const reasoning: Message = { id: "r1", role: "reasoning", content: "thinking" };
	assert.deepEqual([...turnEndReplyIds([user("u1"), reasoning, reply("a1")])], ["a1"]);
	assert.deepEqual([...turnEndReplyIds([reply("a0")])], ["a0"]);
});
