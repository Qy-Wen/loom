import assert from "node:assert/strict";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { atomicWrite, JsonFile } from "../src/main/storage/file.ts";
import { SerialQueue } from "../src/main/storage/serial-queue.ts";
import { ModelSettingsStore } from "../src/main/models/model-settings-store.ts";
import { GeneralSettingsStore } from "../src/main/settings/general-settings-store.ts";
import { AgentPermissionStore } from "../src/main/settings/agent-permission-store.ts";
import { AgentSandboxStore } from "../src/main/settings/agent-sandbox-store.ts";
import { CommandAllowStore } from "../src/main/settings/command-allow-store.ts";
import { McpSettingsStore } from "../src/main/mcp/store.ts";
import { mergeMcpServers } from "../src/main/tools/settings-tools.ts";
import { changedFields } from "../src/shared/settings-changes.ts";
import { emptyMcpServerDraft } from "../src/shared/mcp-settings.ts";

const KEY = Buffer.alloc(32, 7);

async function workspace(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "loom-settings-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("UI model edits and Agent patches preserve independent fields and slots across store instances", async (t) => {
	const file = join(await workspace(t), "models.json");
	const ui = new ModelSettingsStore(file, testChatCipher(KEY)), agent = new ModelSettingsStore(file, testChatCipher(KEY));
	await ui.update({ embedding: { model: "old", requestUrl: "https://example.com/embed", apiKey: "old-key" } });
	const baseline = (await ui.view()).embedding;
	const draft = { ...baseline, model: "from-ui" };
	await Promise.all([
		agent.update({ embedding: { apiKey: "from-agent", enabled: true }, audio: { model: "audio-agent" } }),
		ui.update({ embedding: changedFields(baseline, draft) }),
	]);
	const saved = await ui.load();
	assert.equal(saved.embedding.model, "from-ui");
	assert.equal(saved.embedding.apiKey, "from-agent");
	assert.equal(saved.embedding.enabled, true);
	assert.equal(saved.audio.model, "audio-agent");
	assert.equal(saved.embedding.requestUrl, baseline.requestUrl);
});

test("concurrent model writes stay FIFO and readers only see complete JSON", async (t) => {
	const file = join(await workspace(t), "models.json");
	const store = new ModelSettingsStore(file, testChatCipher(KEY));
	await store.update({});
	const operations = Array.from({ length: 25 }, (_, index) => new ModelSettingsStore(file, testChatCipher(KEY)).update({
		embedding: { model: "m".repeat(index * 100) + index },
	}));
	let reading = true;
	const reader = (async () => {
		while (reading) assert.ok(JSON.parse(await readFile(file, "utf8")).embedding);
	})();
	try { await Promise.all(operations); } finally { reading = false; await reader; }
	assert.equal((await store.load()).embedding.model, "m".repeat(2400) + 24);
});

test("failed model validation preserves the saved file and does not poison the next update", async (t) => {
	const file = join(await workspace(t), "models.json");
	const store = new ModelSettingsStore(file, testChatCipher(KEY));
	await store.update({ embedding: { model: "saved" } });
	const before = await readFile(file, "utf8");
	await assert.rejects(store.update({ embedding: { requestUrl: "bad URL" } }), /Request URL/);
	assert.equal(await readFile(file, "utf8"), before);
	await assert.rejects(store.update({ embedding: { apiKey: "key", clearApiKey: true } }), /set and clear/);
	await store.update({ audio: { model: "next" } });
	assert.equal((await store.load()).embedding.model, "saved");
});

test("general settings merge concurrent fields and do not retain stale cached values", async (t) => {
	const file = join(await workspace(t), "general.json");
	const ui = new GeneralSettingsStore(file), agent = new GeneralSettingsStore(file);
	await ui.load(); await agent.load();
	await Promise.all([ui.save({ reopenLastLibrary: false }), agent.save({ language: "zh-CN" })]);
	assert.deepEqual(await ui.load(), { language: "zh-CN", reopenLastLibrary: false, webTools: true });
	assert.deepEqual(await agent.load(), await ui.load());
});

test("permission saves publish only committed state and later stores see changes", async (t) => {
	const file = join(await workspace(t), "permission.json");
	const ui = new AgentPermissionStore(file), other = new AgentPermissionStore(file);
	await ui.load();
	await other.save("full");
	assert.equal(await ui.load(), "full");
	// An existing directory prevents the temporary file from replacing the destination.
	const blocked = new AgentPermissionStore(await workspace(t));
	await assert.rejects(blocked.save("full"));
	await other.save("basic");
	assert.equal(await ui.load(), "basic");
});

test("MCP UI row edits and Agent updates preserve other rows, secrets and environment references", async (t) => {
	const file = join(await workspace(t), "mcp.json");
	const ui = new McpSettingsStore(file), agent = new McpSettingsStore(file);
	const first = { ...emptyMcpServerDraft(), id: "one", command: "old", envText: "TOKEN=${LOOM_SETTINGS_TEST_TOKEN}" };
	await ui.save([first]);
	const baseline = (await ui.drafts())[0]!;
	await Promise.all([
		agent.update((current) => mergeMcpServers(current, {
			upsert: [{ id: "one", enabled: true }, { id: "two", transport: "stdio", command: "node" }],
		})),
		ui.patch({ upsert: [{ previousId: "one", server: { ...changedFields(baseline, { ...baseline, command: "new" }), id: "one" } }] }),
	]);
	const drafts = await ui.drafts();
	assert.equal(drafts.length, 2);
	assert.equal(drafts[0]!.command, "new");
	assert.equal(drafts[0]!.enabled, true);
	assert.equal(drafts[0]!.envText, first.envText);
	assert.match(await readFile(file, "utf8"), /\$\{LOOM_SETTINGS_TEST_TOKEN\}/);
	await ui.patch({ remove: ["one"] });
	assert.deepEqual((await agent.load()).map((row) => row.id), ["two"]);
});

test("MCP initialization cannot overwrite a concurrent first save; rename collisions preserve the file", async (t) => {
	const file = join(await workspace(t), "mcp.json");
	const a = new McpSettingsStore(file), b = new McpSettingsStore(file);
	await Promise.all([a.ensure(), b.patch({ upsert: [
		{ server: { id: "one", command: "node" } }, { server: { id: "two", command: "node" } },
	] })]);
	const before = await readFile(file, "utf8");
	await assert.rejects(a.patch({ upsert: [{ previousId: "one", server: { id: "two" } }] }), /Duplicate/);
	assert.equal(await readFile(file, "utf8"), before);
	await assert.rejects(a.patch({ upsert: [{ previousId: "deleted", server: { id: "deleted", command: "node" } }] }), /no longer exists/);
	assert.equal((await a.load()).length, 2);
});

test("remembered grants serialize additions and library binding", async (t) => {
	const a = await workspace(t), b = await workspace(t);
	const store = new CommandAllowStore(), other = new CommandAllowStore();
	await store.bind(a); await other.bind(a);
	const added = store.add({ tool: "bash", match: "git status" });
	const switched = store.bind(b);
	await Promise.all([added, switched, other.add({ tool: "bash", match: "git diff" })]);
	assert.equal(store.view().root, b);
	assert.deepEqual(store.view().allows, []);
	assert.equal((await store.bind(a)).allows.length, 2);
});

test("sandbox updates use latest notice across instances and reject stale acknowledgements", async (t) => {
	const file = join(await workspace(t), "sandbox.json");
	const a = new AgentSandboxStore(file), b = new AgentSandboxStore(file);
	await a.recordFailure("first");
	const old = await b.pendingNotice();
	await a.recordFailure("second");
	await b.save(true);
	assert.equal((await a.pendingNotice())?.reason, "second");
	await b.acknowledgeNotice(old!.id);
	assert.equal((await a.pendingNotice())?.reason, "second");
});

test("atomic replacement preserves old contents on pre-commit failure and cleans temporary files", async (t) => {
	const dir = await workspace(t), path = join(dir, "settings.json");
	await atomicWrite(path, '{"saved":true}');
	await assert.rejects(atomicWrite(path, '{"new":true}', () => { throw new Error("commit refused"); }), /commit refused/);
	assert.equal(await readFile(path, "utf8"), '{"saved":true}');
	assert.deepEqual(await readdir(dir), ["settings.json"]);
	await atomicWrite(path, '{"new":true}');
	assert.equal(await readFile(path, "utf8"), '{"new":true}');
});

test("Windows sharing-violation retries retain the destination beyond the old 300ms limit", async (t) => {
	const dir = await workspace(t), path = join(dir, "settings.json");
	await writeFile(path, "old");
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", descriptor));
	const originalRename = fsPromises.rename;
	let attempts = 0;
	const started = performance.now();
	const mocked = t.mock.method(fsPromises, "rename", async (from: fs.PathLike, to: fs.PathLike) => {
		attempts++;
		assert.equal(readFileSync(path, "utf8"), "old");
		if (performance.now() - started < 400) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
		await originalRename(from, to);
	});
	syncBuiltinESMExports();
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
	await atomicWrite(path, "new");
	assert.ok(attempts > 5);
	assert.equal(await readFile(path, "utf8"), "new");
	assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("a busy lock directory is removed before the next storage update starts", async (t) => {
	const dir = await workspace(t), path = join(dir, "settings.json");
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
	t.after(() => Object.defineProperty(process, "platform", descriptor));
	// The lock sits at the canonical path, which differs from the temp path where a directory is a symlink (macOS /var).
	const lockPath = `${join(await realpath(dir), "settings.json")}.lock`;
	const originalRmdir = fs.rmdir;
	let removals = 0;
	t.mock.method(fs, "rmdir", (target: fs.PathLike, callback: fs.NoParamCallback) => {
		if (String(target) === lockPath && ++removals <= 2) {
			queueMicrotask(() => callback(Object.assign(new Error("directory busy"), { code: "EBUSY" })));
		} else originalRmdir(target, callback);
	});
	const a = new JsonFile(path, (value) => value as { count: number });
	const b = new JsonFile(path, a.parse);
	await Promise.all([a, b].map((file) => file.update(async (current) => ({ value: { count: (current?.count ?? 0) + 1 }, result: undefined }))));
	assert.equal(removals, 4);
	assert.deepEqual(await a.read(), { count: 2 });
	assert.deepEqual(await readdir(dir), ["settings.json"]);
});

test("serialized operations keep runtime effects in order and recover from failure", async () => {
	const queue = new SerialQueue(), events: number[] = [];
	await Promise.all([
		queue.run(async () => { events.push(1); await Promise.resolve(); events.push(2); }),
		assert.rejects(queue.run(async () => { events.push(3); throw new Error("failed"); }), /failed/),
		queue.run(async () => { events.push(4); }),
	]);
	assert.deepEqual(events, [1, 2, 3, 4]);
	assert.equal(queue.idle, true);
});

test("JSON mutations recover after a thrown change without changing saved state", async (t) => {
	const path = join(await workspace(t), "value.json");
	const file = new JsonFile(path, (value) => value as { count: number });
	await file.update(async () => ({ value: { count: 1 }, result: undefined }));
	await assert.rejects(file.update(async () => { throw new Error("failed"); }), /failed/);
	await file.update(async (current) => ({ value: { count: current!.count + 1 }, result: undefined }));
	assert.deepEqual(await file.read(), { count: 2 });
});
