import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LoomSessionSummary } from "@loom/agent";
import { emptySessionTabUnreadState, reconcileSessionTabUnread } from "../src/renderer/chat/session-tab-unread.ts";

function session(id: string, busy = false, status: "open" | "archived" = "open"): LoomSessionSummary {
	return { id, title: `Session ${id}`, status, busy, createdAt: 1, updatedAt: 1 };
}

describe("session tab unread completion indicator", () => {
	it("marks an inactive session unread when it finishes running, and clears it on activation", () => {
		const started = reconcileSessionTabUnread(
			emptySessionTabUnreadState,
			[session("a", false), session("b", true)],
			"a",
		);
		assert.deepEqual([...started.unreadIds], []);

		const finished = reconcileSessionTabUnread(
			started,
			[session("a", false), session("b", false)],
			"a",
		);
		assert.deepEqual([...finished.unreadIds], ["b"]);

		const activated = reconcileSessionTabUnread(
			finished,
			[session("a", false), session("b", false)],
			"b",
		);
		assert.deepEqual([...activated.unreadIds], []);
	});

	it("does not mark the active session unread when it finishes running", () => {
		const started = reconcileSessionTabUnread(
			emptySessionTabUnreadState,
			[session("a", true), session("b", false)],
			"a",
		);
		const finished = reconcileSessionTabUnread(
			started,
			[session("a", false), session("b", false)],
			"a",
		);
		assert.deepEqual([...finished.unreadIds], []);
	});

	it("tracks a session that started while active and finished after switching to another tab", () => {
		const started = reconcileSessionTabUnread(
			emptySessionTabUnreadState,
			[session("a", true), session("b", false)],
			"a",
		);
		const switched = reconcileSessionTabUnread(
			started,
			[session("a", true), session("b", false)],
			"b",
		);
		assert.deepEqual([...switched.unreadIds], []);

		const finished = reconcileSessionTabUnread(
			switched,
			[session("a", false), session("b", false)],
			"b",
		);
		assert.deepEqual([...finished.unreadIds], ["a"]);
	});

	it("clears the unread mark when the session starts running again", () => {
		let state = reconcileSessionTabUnread(emptySessionTabUnreadState, [session("a"), session("b", true)], "a");
		state = reconcileSessionTabUnread(state, [session("a"), session("b", false)], "a");
		assert.deepEqual([...state.unreadIds], ["b"]);

		state = reconcileSessionTabUnread(state, [session("a"), session("b", true)], "a");
		assert.deepEqual([...state.unreadIds], []);

		state = reconcileSessionTabUnread(state, [session("a"), session("b", false)], "a");
		assert.deepEqual([...state.unreadIds], ["b"]);
	});

	it("prunes archived or deleted sessions and tracks multiple background completions independently", () => {
		let state = reconcileSessionTabUnread(
			emptySessionTabUnreadState,
			[session("a"), session("b", true), session("c", true), session("d", true)],
			"a",
		);
		state = reconcileSessionTabUnread(
			state,
			[session("a"), session("b", false), session("c", false), session("d", false, "archived")],
			"a",
		);
		assert.deepEqual([...state.unreadIds], ["b", "c"]);

		// Archiving or deleting drops unread marks; activating one keeps the other unread.
		state = reconcileSessionTabUnread(
			state,
			[session("a"), session("b", false, "archived"), session("c", false)],
			"a",
		);
		assert.deepEqual([...state.unreadIds], ["c"]);

		const unchanged = reconcileSessionTabUnread(
			state,
			[session("a"), session("b", false, "archived"), session("c", false)],
			"a",
		);
		assert.equal(unchanged, state);

		state = reconcileSessionTabUnread(
			state,
			[session("a")],
			"a",
		);
		assert.deepEqual([...state.unreadIds], []);
	});
});
