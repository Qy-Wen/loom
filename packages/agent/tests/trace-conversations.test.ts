import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore, TRACE_RETENTION_MS, traceConversationId, type LoomTraceRecord } from "../src/trace/trace-store.ts";

const record = (id: string, threadId: string, at: number, status: LoomTraceRecord["status"] = "completed"): LoomTraceRecord => ({ id, threadId, at, status, revision: 1, spans: [] });

test("conversation summaries group native identities without merging unrelated or unknown roots", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-trace-conversations-"));
	const store = await TraceStore.open(root);
	try {
		const now = Date.now();
		store.save(record("a", "1", now - 10, "running")); store.save(record("b", "1", now));
		store.save(record("specialist", "2", now + 1));
		store.save(record("unknown-a", "", now + 2)); store.save(record("unknown-b", "", now + 2));
		const rows = store.conversations(2);
		assert.deepEqual(rows.map((row) => row.id), ["trace:unknown-b", "trace:unknown-a"]);
		const next = store.conversations(2, { at: rows[1]!.at, id: rows[1]!.id });
		assert.deepEqual(next.map((row) => row.id), ["2", "1"]);
		assert.equal(next[1]!.count, 2); assert.equal(next[1]!.status, "running");
		assert.deepEqual(store.conversation("1", 1).map((row) => row.id), ["b"]);
		assert.deepEqual(store.conversation("1", 1, { at: now, id: "b" }).map((row) => row.id), ["a"]);
		assert.deepEqual(store.conversation("trace:unknown-a").map((row) => row.id), ["unknown-a"]);
		assert.equal(traceConversationId(record("missing", "", now)), "trace:missing");
		assert.throws(() => store.conversations(201)); assert.throws(() => store.conversation("1", 0));
	} finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a busy conversation cannot crowd older conversations out of summary pagination", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-trace-conversations-")); const store = await TraceStore.open(root);
	try {
		const now = Date.now();
		for (let i = 0; i < 45; i++) store.save(record(`r${i}`, "busy", now + i));
		store.save(record("older", "quiet", now - 1));
		assert.deepEqual(store.conversations().map((row) => [row.id, row.count]), [["busy", 45], ["quiet", 1]]);
		assert.equal(store.conversation("busy").length, 40);
		const oldest = store.conversation("busy").at(-1)!;
		assert.equal(store.conversation("busy", 40, { at: oldest.at, id: oldest.id }).length, 5);
		// Retention is based on the last update, not the age of the submission.
		store.save(record("old-but-updated", "recovered", now - TRACE_RETENTION_MS - 100));
		assert.ok(store.conversations().some((row) => row.id === "recovered"));
	} finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
