import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@loom/agent";
import { LibraryAgentHost } from "../src/main/library-agent-host.ts";

test("app fork-before switches context, archives source, and hides deletion without breaking ancestry", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-"));
	const host = new LibraryAgentHost({});
	try {
		await host.openLibrary(path);
		const record = await host.createSession();
		await host.setSessionName(record.id, "Project");
		const conversation = await host.conversation(record.id);
		const first = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "first", timestamp: 1 }] }), context);
		const second = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "second", timestamp: 2 }] }), context);
		const fork = await host.branchBefore(record.id, String(second.id));
		assert.equal(fork.title, "Project（分支）");
		assert.equal(fork.messages.length, 1);
		assert.equal(fork.messages[0]?.content, "first");
		assert.equal((await host.getSession(record.id)).status, "archived");
		const empty = await host.forkBefore(record.id, String(first.id));
		assert.equal(empty.messages.length, 0);
		await host.deleteSession(record.id);
		assert.equal((await host.listSessions()).some((row) => row.id === record.id), false);
		assert.equal((await host.getSession(fork.id)).messages[0]?.content, "first");
		await host.close(); await host.openLibrary(path);
		assert.equal((await host.getSession(fork.id)).messages[0]?.content, "first");
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});
