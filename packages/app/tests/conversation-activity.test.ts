import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, ConversationId, EntryId, SnapshotEvent, SubmissionId } from "@loom/agent";
import { createConversationActivity } from "../src/main/chat/conversation-activity.ts";

const first = 1 as SubmissionId;
const second = 2 as SubmissionId;
const snapshot = (value: Partial<SnapshotEvent> = {}): SnapshotEvent => ({
	type: "snapshot", entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: { models: {}, tools: {} }, ...value,
});
const settled = (id = first): AgentEvent => ({ type: "submission", record: {
	id, conversationId: 1 as ConversationId, type: "input", status: "done", entry: 1 as EntryId, answer: 2 as EntryId,
} });
async function pending(idle: Promise<void>) {
	let finished = false;
	void idle.then(() => { finished = true; });
	await Promise.resolve();
	assert.equal(finished, false, "the observer must stay attached");
}

test("a new request does not finish at the idle snapshot taken before admission", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	await pending(activity.idle);
	activity.apply([{ type: "run_start", inputs: [first] }]);
	await pending(activity.idle);
	activity.apply([{ type: "run_end", inputs: [first] }, settled()]);
	await activity.idle;
});

test("completion is checked after the entire commit, including a follow-up start", async () => {
	const activity = createConversationActivity(snapshot({ run: { inputs: [first] } }), { id: first, existedAtSnapshot: true });
	activity.apply([{ type: "run_end", inputs: [first] }, settled(), { type: "run_start", inputs: [second] }]);
	await pending(activity.idle);
	activity.apply([{ type: "run_end", inputs: [second] }, settled(second)]);
	await activity.idle;
});

test("paused follow-ups after a failed run do not keep the chat stream open", async () => {
	const activity = createConversationActivity(snapshot({ run: { inputs: [first] }, inbox: [{ id: second, mode: "followUp" }] }));
	activity.apply([{ type: "run_end", inputs: [first] }, { type: "submission", record: {
		id: first, conversationId: 1 as ConversationId, type: "input", status: "unanswered", reason: "model_error",
	} }]);
	await activity.idle;
	await createConversationActivity(snapshot({ inbox: [{ id: second, mode: "followUp" }] })).idle;
});

test("overflow snapshots recover completion even when run and submission events were dropped", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	activity.apply([snapshot({ run: { inputs: [first] } })]);
	await pending(activity.idle);
	activity.apply([snapshot({ run: { inputs: [second] } })]);
	await pending(activity.idle);
	activity.apply([snapshot()]);
	await activity.idle;
	const fast = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	fast.apply([snapshot()]);
	await fast.idle;
});

test("another request settling cannot complete a new request before its events arrive", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	activity.apply([settled(second)]);
	await pending(activity.idle);
	activity.apply([{ type: "run_start", inputs: [first] }]);
	activity.apply([{ type: "run_end", inputs: [first] }, settled()]);
	await activity.idle;
});

test("an already completed request needs no new event, including after history compaction", async () => {
	await createConversationActivity(snapshot(), { id: first, existedAtSnapshot: true }).idle;
});

test("a reconnect keeps watching the active run without submitting a request", async () => {
	const activity = createConversationActivity(snapshot({ run: { inputs: [first] } }));
	await pending(activity.idle);
	activity.apply([snapshot()]);
	await activity.idle;
});

test("passive entry writes do not keep an otherwise finished chat stream open", async () => {
	await createConversationActivity(snapshot({ inbox: [{ id: first, mode: "write" }] })).idle;
});
