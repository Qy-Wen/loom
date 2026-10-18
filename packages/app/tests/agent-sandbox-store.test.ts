import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSandboxStore } from "../src/main/settings/agent-sandbox-store.ts";
import { processSandboxActive } from "../src/shared/agent-sandbox.ts";

test("AgentSandboxStore defaults on and round-trips the switch", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-agent-sandbox-"));
	const file = join(root, "agent-sandbox.json");
	try {
		const store = new AgentSandboxStore(file);
		assert.equal(await store.load(), true);
		assert.equal(await store.save(false), false);
		assert.equal(await readFile(file, "utf8"), `${JSON.stringify({ enabled: false }, null, "\t")}\n`);
		assert.equal(await new AgentSandboxStore(file).load(), false);

		await writeFile(file, "{}\n", "utf8");
		assert.equal(await new AgentSandboxStore(file).load(), true);
		assert.equal(processSandboxActive(true, "standard"), true);
		assert.equal(processSandboxActive(true, "full"), false);
		assert.equal(processSandboxActive(false, "basic"), false);
		assert.equal(await store.pendingNotice(), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("sandbox failure notice survives startup, reload and restart until explicitly acknowledged", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-sandbox-notice-"));
	const file = join(root, "agent-sandbox.json");
	try {
		const store = new AgentSandboxStore(file);
		await store.recordFailure("WFP fence inactive before the renderer subscribed");
		const notice = await store.pendingNotice();
		assert.ok(notice);
		assert.equal(await store.load(), false);
		// Reading/reloading is not acknowledgement.
		assert.deepEqual(await store.pendingNotice(), notice);
		const reopened = new AgentSandboxStore(file);
		assert.deepEqual(await reopened.pendingNotice(), notice);
		assert.equal(await reopened.load(), false);
		await reopened.save(true);
		assert.deepEqual(await new AgentSandboxStore(file).pendingNotice(), notice);
		await reopened.acknowledgeNotice("stale-id");
		assert.deepEqual(await reopened.pendingNotice(), notice);
		await reopened.recordFailure("new failure");
		const next = await reopened.pendingNotice();
		assert.ok(next);
		assert.notEqual(next.id, notice.id);
		await reopened.acknowledgeNotice(notice.id);
		assert.deepEqual(await reopened.pendingNotice(), next, "a stale renderer cannot clear a newer failure");
		await reopened.acknowledgeNotice(next.id);
		assert.equal(await new AgentSandboxStore(file).pendingNotice(), null);
		assert.equal(await new AgentSandboxStore(file).load(), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("overlapping settings saves and acknowledgement preserve the latest fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-sandbox-notice-overlap-"));
	const file = join(root, "agent-sandbox.json");
	try {
		const store = new AgentSandboxStore(file);
		await store.load();
		await store.recordFailure("old failure");
		const old = await store.pendingNotice();
		await Promise.all([store.acknowledgeNotice(old!.id), store.save(true), store.recordFailure("latest failure")]);
		const reopened = new AgentSandboxStore(file);
		assert.equal(await reopened.load(), false);
		assert.equal((await reopened.pendingNotice())?.reason, "latest failure");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed notice persistence still retains the fallback state for a late renderer", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-sandbox-notice-failure-"));
	const file = join(root, "not-a-directory");
	try {
		const store = new AgentSandboxStore(join(file, "agent-sandbox.json"));
		// Load defaults before simulating a settings path becoming unwritable.
		await store.load();
		await writeFile(file, "block writes");
		await assert.rejects(store.recordFailure("ACL initialization failed"));
		assert.equal(await store.load(), false);
		assert.equal((await store.pendingNotice())?.reason, "ACL initialization failed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
