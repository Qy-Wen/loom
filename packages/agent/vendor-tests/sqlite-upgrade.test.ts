import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { BACKGROUND_CONTEXT as context, openNodeSqliteStorage, type ConversationId, type TaskId, type TaskRecord } from "@loom/agent/durable";
import { applySqliteMigrations, SQLITE_MIGRATIONS } from "../vendor-pi-durable/src/storage/sqlite/migrations.ts";

test("schema v1 tasks survive the v2 upgrade and persist the new sleeping state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "loom-durable-upgrade-"));
	const path = join(directory, "session.sqlite");
	const original: TaskRecord<{ note: string }, { phase: string }, null> = {
		id: 3 as TaskId<null>, conversationId: 2 as ConversationId, kind: "test.upgrade", version: 1,
		input: { note: "preserve me" }, background: false, abortRequested: false,
		state: { status: "pending", checkpoint: { phase: "resume" } },
	};
	try {
		const database = await openNodeSqliteDatabase(path);
		try {
			await applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 1));
			await database.run("INSERT INTO record_ids (id, record_type) VALUES (2, 'conversation'), (3, 'task')");
			await database.run("INSERT INTO conversations (id, record) VALUES (2, ?)", JSON.stringify({ id: 2 }));
			await database.run("INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (3, 2, 'test.upgrade', 'pending', 0, 0, ?)", JSON.stringify(original));
			await database.run("UPDATE durable_metadata SET next_id = '4'");
		} finally { await database.close(); }
		let storage = await openNodeSqliteStorage(path);
		try {
			assert.deepEqual(await storage.task(original.id, context), original);
			const sleeping = { ...original, state: { status: "sleeping" as const, checkpoint: { phase: "resume" }, until: 12345 } };
			await storage.commit([{ type: "task", value: sleeping }], context);
			await storage.close(context);
			storage = await openNodeSqliteStorage(path);
			assert.deepEqual(await storage.task(original.id, context), sleeping);
			assert.deepEqual((await storage.scanTasks({ status: "sleeping" }, 10, undefined, context)).items, [sleeping]);
		} finally { await storage.close(context); }
		const upgraded = await openNodeSqliteDatabase(path);
		try {
			assert.equal((await upgraded.get<{ version: number }>("SELECT version FROM durable_schema"))?.version, 2);
			await assert.rejects(applySqliteMigrations(upgraded, SQLITE_MIGRATIONS.slice(0, 1)), /newer than supported/);
		} finally { await upgraded.close(); }
	} finally { await rm(directory, { recursive: true, force: true }); }
});
