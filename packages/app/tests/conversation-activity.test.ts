import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationId, ConversationView, EntryId, SubmissionId } from "@loom/agent";
import { createConversationActivity } from "../src/main/chat/conversation-activity.ts";

const first = 1 as SubmissionId;
const second = 2 as SubmissionId;
const snapshot = (run?: SubmissionId[], inbox: SubmissionId[] = [], tail = 0): ConversationView => ({
	conversation: { id: 1 as ConversationId }, entries: [], ...(tail ? { before: tail as EntryId } : {}),
	docs: { "pi.live": run ? { run: { taskId: 10, inputs: run, turns: 0 } } : {}, "pi.inbox": { items: inbox.map((id) => ({ id, mode: "followUp" })) } },
});
async function pending(idle: Promise<void>) {
	let finished = false;
	void idle.then(() => { finished = true; });
	await Promise.resolve();
	assert.equal(finished, false, "the observer must stay attached");
}

test("a new request waits for settlement and for its answer to be presented", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	await pending(activity.idle);
	activity.settle(20 as EntryId);
	await pending(activity.idle);
	activity.apply(snapshot([first], [], 15));
	await pending(activity.idle);
	activity.apply(snapshot(undefined, [], 20));
	await activity.idle;
});

test("presentation before settlement also waits for the submission", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	activity.apply(snapshot(undefined, [], 20));
	await pending(activity.idle);
	activity.settle(20 as EntryId);
	await activity.idle;
});

test("a follow-up started in the same view keeps the stream open", async () => {
	const activity = createConversationActivity(snapshot([first]), { id: first, existedAtSnapshot: true });
	activity.apply(snapshot([second], [], 20));
	activity.settle(20 as EntryId);
	await pending(activity.idle);
	activity.apply(snapshot(undefined, [], 30));
	await activity.idle;
});

test("paused follow-ups after a failed run do not keep the stream open", async () => {
	const activity = createConversationActivity(snapshot([first], [second]));
	activity.apply(snapshot(undefined, [second]));
	await activity.idle;
	await createConversationActivity(snapshot(undefined, [second])).idle;
});

test("coalesced views can skip the entire run without losing completion", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	activity.apply(snapshot(undefined, [], 20));
	activity.settle(20 as EntryId);
	await activity.idle;
});

test("an unrelated state update cannot complete an unadmitted request", async () => {
	const activity = createConversationActivity(snapshot(), { id: first, existedAtSnapshot: false });
	activity.apply(snapshot(undefined, [], 5));
	await pending(activity.idle);
	activity.apply(snapshot([first], [], 10));
	activity.settle(20 as EntryId);
	await pending(activity.idle);
	activity.apply(snapshot(undefined, [], 20));
	await activity.idle;
});

test("a withdrawn queued request waits until its removal has been presented", async () => {
	const activity = createConversationActivity(snapshot(undefined, [first]), { id: first, existedAtSnapshot: true });
	activity.settle();
	await pending(activity.idle);
	activity.apply(snapshot());
	await activity.idle;
});

test("completed requests and idle reconnects finish without a new revision", async () => {
	await createConversationActivity(snapshot(), { id: first, existedAtSnapshot: true }).idle;
	await createConversationActivity(snapshot()).idle;
});

test("a reconnect keeps watching the active run without submitting", async () => {
	const activity = createConversationActivity(snapshot([first]));
	await pending(activity.idle);
	activity.apply(snapshot());
	await activity.idle;
});
