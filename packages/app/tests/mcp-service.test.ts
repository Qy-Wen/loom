import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalCore, tryResolveMediaBinaries } from "@loom/core";
import { ToolExecutor } from "@loom/agent/tools";
import { createAppToolCatalog } from "../src/main/tools/catalog.ts";
import { encodeMcpResult, startMcpService } from "../src/main/mcp-service/server.ts";
import { McpServiceStore } from "../src/main/mcp-service/store.ts";
import type { ExternalToolTask } from "../src/shared/mcp-service.ts";

const token = "a".repeat(64);
async function waitFor(condition: () => boolean) { const deadline = Date.now() + 5000; while (!condition()) { if (Date.now() > deadline) assert.fail("Timed out waiting for tool state"); await sleep(10); } }
async function fixture(accessToken = token, options: { describeImage?: (assetId: string, signal?: AbortSignal) => Promise<never> } = {}) {
	const root = await mkdtemp(join(tmpdir(), "loom-public-mcp-"));
	const core = new LocalCore();
	await writeFile(join(root, "note.md"), "one\ntwo\nthree\nfour\n");
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, "still.png"));
	await core.openLibrary(root);
	const unused = async (): Promise<never> => { throw new Error("Provider not configured"); };
	const executor = new ToolExecutor(createAppToolCatalog(core, { assets: { embedAsset: unused, describeImage: options.describeImage ?? unused, describeVideo: unused, describeAudio: unused }, settings: { read: unused, apply: unused } }));
	let tasks: ExternalToolTask[] = [];
	const service = await startMcpService({ executor, bindLibrary: async () => { const library = core.bindLibraryTasks(); return library.run(async () => ({ library, root: (await core.getLibrarySnapshot()).rootPath! })); }, onTasks: (value) => { tasks = value; } }, { port: 0, token: accessToken });
	const clients: Client[] = [];
	async function connect() {
		const client = new Client({ name: "test-external-agent", version: "1" });
		const transport = new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} } });
		await client.connect(transport); clients.push(client); return { client, transport };
	}
	return { root, core, service, executor, connect, tasks: () => tasks, async close() { await service.close(); await Promise.allSettled(clients.map((client) => client.close())); await core.close(); await rm(root, { recursive: true, force: true }); } };
}

test("real MCP client discovers 29 shared tools, reads portable results, and organizes files by stable ID", { timeout: 30_000 }, async () => {
	const f = await fixture();
	try {
		const { client } = await f.connect();
		const tools = (await client.listTools()).tools;
		assert.equal(tools.length, 29);
		assert.equal(tools.find((tool) => tool.name === "read_asset")!.annotations?.readOnlyHint, true);
		assert.equal(tools.find((tool) => tool.name === "create_folder")!.annotations?.destructiveHint, false);
		assert.equal(tools.find((tool) => tool.name === "rename_asset")!.annotations?.destructiveHint, true);
		assert.equal(tools.find((tool) => tool.name === "describe_image")!.annotations?.openWorldHint, true);
		assert.equal(tools.find((tool) => tool.name === "run_ffmpeg")!.annotations?.openWorldHint, true);
		assert.equal(tools.find((tool) => tool.name === "run_ffmpeg")!.annotations?.destructiveHint, true);
		assert.equal(tools.find((tool) => tool.name === "run_ffprobe")!.annotations?.openWorldHint, true);
		for (const name of ["read", "write", "edit", "bash", "powershell", "auto_memory", "get_settings", "update_settings", "run_create_agent"]) assert.ok(!tools.some((tool) => tool.name === name));
		const library = await client.callTool({ name: "get_library", arguments: {} });
		assert.equal((library.structuredContent as { rootPath: string }).rootPath, f.root);
		const note = (await f.core.getLibrarySnapshot()).assets.find((asset) => asset.filename === "note.md")!;
		const image = (await f.core.getLibrarySnapshot()).assets.find((asset) => asset.filename === "still.png")!;
		const read = await client.callTool({ name: "read_asset", arguments: { assetId: note.assetId, offset: 2, limit: 2 } });
		assert.deepEqual(read.structuredContent, { assetId: note.assetId, offset: 2, lines: 2, text: "two\nthree", truncated: true, nextOffset: 4 });
		const pixels = await client.callTool({ name: "read_asset", arguments: { assetId: image.assetId } });
		assert.equal((pixels.content as { type: string }[])[0]!.type, "image");
		assert.ok(!JSON.stringify(pixels).includes("loom-asset:"));
		if (tryResolveMediaBinaries()) {
			const thumbnail = await client.callTool({ name: "read_asset", arguments: { assetId: image.assetId, view: "thumbnail" } });
			assert.equal(thumbnail.isError, undefined, JSON.stringify(thumbnail));
			assert.equal((thumbnail.structuredContent as { view: string }).view, "thumbnail");
		}
		const inspect = await client.callTool({ name: "inspect_asset", arguments: { assetId: image.assetId } });
		assert.equal((inspect.structuredContent as Record<string, unknown>).previewRef, undefined);
		assert.equal((inspect.structuredContent as Record<string, unknown>).readTool, "read_asset");
		assert.equal((await client.callTool({ name: "create_folder", arguments: { parentRelativePath: "", name: "Inbox" } })).isError, undefined);
		await client.callTool({ name: "rename_asset", arguments: { assetId: note.assetId, stem: "renamed" } });
		const moved = await client.callTool({ name: "move_assets", arguments: { assetIds: [note.assetId, "missing"], destFolder: "Inbox" } });
		assert.deepEqual((moved.structuredContent as { results: { success: boolean }[] }).results.map((row) => row.success), [true, false]);
		await client.callTool({ name: "rename_folder", arguments: { relativePath: "Inbox", name: "Notes" } });
		await client.callTool({ name: "create_folder", arguments: { parentRelativePath: "", name: "Archive" } });
		await client.callTool({ name: "move_folder", arguments: { sourceFolder: "Notes", destFolder: "Archive" } });
		assert.equal((await f.core.getAsset(note.assetId))!.relativePath, "Archive/Notes/renamed.md");
		await client.callTool({ name: "add_tag", arguments: { assetId: note.assetId, name: "MCP" } });
		assert.deepEqual(await f.core.listTagUsage(), [{ name: "MCP", count: 1 }]);
		for (const [name, args] of [["read_asset", { assetId: note.assetId, offset: 0 }], ["rename_asset", { assetId: note.assetId, stem: "../escape" }], ["create_folder", { parentRelativePath: "", name: ".loom" }], ["deep_search_assets", {}], ["get_settings", {}]] as const) {
			assert.equal((await client.callTool({ name, arguments: args })).isError, true);
		}
		assert.ok(f.tasks().some((task) => task.status === "completed" && task.client === "test-external-agent"));
		const internal = f.executor.agentTools(() => f.core.bindLibraryTasks()).find((tool) => tool.name === "read_asset")!;
		assert.deepEqual((await internal.execute({ assetId: note.assetId, offset: 2, limit: 2 }) as { data: unknown }).data, read.structuredContent);
	} finally { await f.close(); }
});

test("read_asset bounds text output and rejects non-text content", { timeout: 15_000 }, async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.root, "long.txt"), ("x".repeat(1023) + "\n").repeat(100));
		await writeFile(join(f.root, "audio.mp3"), "not text");
		await f.core.openLibrary(f.root);
		const { client } = await f.connect();
		const assets = (await f.core.getLibrarySnapshot()).assets;
		const long = assets.find((asset) => asset.filename === "long.txt")!;
		const result = await client.callTool({ name: "read_asset", arguments: { assetId: long.assetId, limit: 100 } });
		const data = result.structuredContent as { text: string; truncated: boolean; nextOffset: number };
		assert.equal(data.truncated, true); assert.ok(Buffer.byteLength(data.text) <= 50 * 1024); assert.equal(data.nextOffset, 51);
		const audio = assets.find((asset) => asset.filename === "audio.mp3")!;
		assert.equal((await client.callTool({ name: "read_asset", arguments: { assetId: audio.assetId } })).isError, true);
	} finally { await f.close(); }
});

test("MCP authentication, Host/Origin validation, initialization, and body limits", { timeout: 20_000 }, async () => {
	const f = await fixture();
	try {
		assert.equal((await fetch(f.service.url)).status, 401);
		assert.equal((await fetch(f.service.url, { headers: { Authorization: "Bearer wrong" } })).status, 401);
		const hostStatus = await new Promise<number | undefined>((resolve, reject) => { const req = request(f.service.url, { headers: { Host: "evil.example", Authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); });
		assert.equal(hostStatus, 403);
		assert.equal((await fetch(f.service.url, { headers: { Origin: "https://evil.example", Authorization: `Bearer ${token}` } })).status, 403);
		assert.equal((await fetch(f.service.url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status, 400);
		assert.equal((await fetch(f.service.url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "x".repeat(1024 * 1024 + 1) })).status, 413);
		const { transport } = await f.connect();
		assert.ok(transport.sessionId);
		await transport.terminateSession();
		assert.equal((await fetch(f.service.url, { headers: { Authorization: `Bearer ${token}`, "mcp-session-id": transport.sessionId ?? "expired" } })).status, 404);
	} finally { await f.close(); }
});

test("an empty token accepts a real MCP client without authorization headers", { timeout: 15_000 }, async () => {
	const f = await fixture("");
	try {
		const { client } = await f.connect();
		assert.equal((await client.listTools()).tools.length, 29);
		assert.equal((await client.callTool({ name: "list_tags", arguments: {} })).isError, undefined);
		assert.equal((await fetch(f.service.url, { headers: { Origin: "https://evil.example" } })).status, 403);
	} finally { await f.close(); }
});

test("external execution supports protocol cancellation, local stop, library switching, and shutdown without approvals", { timeout: 30_000 }, async () => {
	let started = 0;
	const f = await fixture(token, { describeImage: async (_assetId, signal) => {
		started++;
		return new Promise<never>((_resolve, reject) => {
			const abort = () => reject(signal!.reason);
			if (signal!.aborted) abort();
			else signal!.addEventListener("abort", abort, { once: true });
		});
	} });
	const next = await mkdtemp(join(tmpdir(), "loom-mcp-next-"));
	try {
		const { client, transport } = await f.connect();
		let assetId = (await f.core.getLibrarySnapshot()).assets.find((asset) => asset.filename === "still.png")!.assetId;
		const run = (options = {}) => client.callTool({ name: "describe_image", arguments: { assetId } }, undefined, { timeout: 5000, ...options });
		assert.equal((await client.callTool({ name: "create_folder", arguments: { parentRelativePath: "", name: "Direct" } })).isError, undefined);
		const controller = new AbortController(); const events: unknown[] = [];
		const cancelled = run({ signal: controller.signal, onprogress: (event: unknown) => events.push(event) });
		const cancellation = assert.rejects(cancelled);
		await waitFor(() => started === 1); controller.abort(); await cancellation;
		await waitFor(() => f.tasks()[0]?.status === "cancelled"); assert.ok(events.length > 0);
		const stopped = run(); await waitFor(() => started === 2);
		assert.equal(f.service.cancel(f.tasks()[0]!.id), true); assert.equal((await stopped).isError, true);
		const switching = run(); const switchingResult = switching.catch(() => undefined);
		await waitFor(() => started === 3);
		await f.service.invalidate(); await switchingResult;
		await copyFile(join(f.root, "still.png"), join(next, "still.png"));
		await f.core.openLibrary(next);
		assert.equal(f.tasks()[0]!.status, "cancelled");
		assert.deepEqual((await f.core.getLibrarySnapshot()).folders, []);
		assert.equal((await fetch(f.service.url, { headers: { Authorization: `Bearer ${token}`, "mcp-session-id": transport.sessionId! } })).status, 404);
		const fresh = await f.connect(); assert.equal((await fresh.client.callTool({ name: "get_library" })).isError, undefined);
		assetId = (await f.core.getLibrarySnapshot()).assets[0]!.assetId;
		const shutdown = fresh.client.callTool({ name: "describe_image", arguments: { assetId } }, undefined, { timeout: 5000 }).catch(() => undefined);
		await waitFor(() => started === 4);
		await f.service.close(); await shutdown;
		assert.equal(f.tasks()[0]!.status, "cancelled");
	} finally { await f.close(); await rm(next, { recursive: true, force: true }); }
});

test("MCP media tools share Agent capabilities for absolute paths, filters, and explicit overwrite", { timeout: 20_000 }, async (t) => {
	if (!tryResolveMediaBinaries()) { t.skip("bundled ffmpeg is not installed"); return; }
	const f = await fixture(); const outside = await mkdtemp(join(tmpdir(), "loom-mcp-outside-"));
	try {
		const { client } = await f.connect();
		const input = join(outside, "input.png"); const output = join(outside, "small.png");
		await copyFile(join(f.root, "still.png"), input);
		const args = { args: ["-y", "-i", input, "-filter_complex", "[0:v]scale=32:32[out]", "-map", "[out]", output] };
		const internal = f.executor.agentTools(() => f.core.bindLibraryTasks()).find((tool) => tool.name === "run_ffmpeg")!;
		const expected = await internal.execute(args) as { data: unknown };
		const pixels = await readFile(output);
		await writeFile(output, "previous output");
		const result = await client.callTool({ name: "run_ffmpeg", arguments: args });
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.deepEqual(result.structuredContent, expected.data);
		assert.deepEqual(await readFile(output), pixels);
		const probe = await client.callTool({ name: "run_ffprobe", arguments: { args: ["-v", "error", "-of", "json", "-show_streams", output] } });
		assert.equal(probe.isError, undefined, JSON.stringify(probe));
		assert.equal(JSON.parse((probe.structuredContent as { stdout: string }).stdout).streams[0].width, 32);
		const grade = await client.callTool({ name: "grade_image", arguments: { path: input, brightness: 0.1 } });
		assert.equal(grade.isError, undefined, JSON.stringify(grade));
	} finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test("MCP defaults to no authentication, encrypts custom tokens, and supports clearing them", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-mcp-token-"));
	const key = randomBytes(32);
	const cipher = { available: () => true, encrypt(value: string) { const iv = randomBytes(12); const encryption = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([encryption.update(value, "utf8"), encryption.final()]); return Buffer.concat([iv, encryption.getAuthTag(), data]); }, decrypt(value: Buffer) { const decryption = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decryption.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decryption.update(value.subarray(28)), decryption.final()]).toString("utf8"); } };
	try {
		const path = join(root, "service.json"); const store = new McpServiceStore(path, cipher);
		assert.deepEqual(await store.load(), { enabled: false, port: 19441, token: "" });
		const saved = await store.save({ enabled: true, port: 19441, token: "my-custom-loom-token" });
		assert.equal(saved.token, "my-custom-loom-token"); assert.ok(!(await readFile(path, "utf8")).includes(saved.token));
		assert.deepEqual(await store.load(), saved);
		assert.equal((await store.save({ enabled: false, port: 19442, token: saved.token })).token, saved.token);
		const unavailable = new McpServiceStore(path, { ...cipher, available: () => false });
		await assert.rejects(unavailable.save({ enabled: true, port: 19441, token: saved.token }), /encryption/);
		await unavailable.save({ enabled: true, port: 19441, token: "" });
		assert.equal((await unavailable.load()).token, "");
		assert.equal(JSON.parse(await readFile(path, "utf8")).encryptedToken, "");
		for (const invalid of ["bad\ntoken", "two words", "x".repeat(513)]) await assert.rejects(store.save({ enabled: true, port: 19441, token: invalid }), /Access token/);
		// Previously generated tokens remain valid; existing credentials are not silently removed.
		const previous = "b".repeat(64);
		await writeFile(path, JSON.stringify({ enabled: true, port: 19441, encryptedToken: cipher.encrypt(previous).toString("base64") }));
		assert.equal((await store.load()).token, previous);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("MCP result encoding never exports local UI details", () => {
	assert.deepEqual(encodeMcpResult("test", { content: "ok", data: [1, 2], details: { private: "local" } }), { content: [{ type: "text", text: "ok" }], structuredContent: { result: [1, 2] } });
});
