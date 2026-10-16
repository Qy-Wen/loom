import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT as context, CompactionTask, defineExtension, hook, InboxDoc } from "@loom/agent/durable";
import type { LoomTool } from "@loom/agent";
import { LibraryAgentHost } from "../src/main/library-agent-host.ts";
import { testChatRuntime } from "./fixtures/test-chat-runtime.ts";
import { createModels } from "@earendil-works/pi-ai/models";

test("MCP tools stay shared on live updates without reopening the library", async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-mcp-"));
	const publish: LoomTool = { name: "social__publish", description: "Publish", parameters: { type: "object" }, execute: () => "published" };
	const generate: LoomTool = { name: "comfy__generate", description: "Generate", parameters: { type: "object" }, execute: () => "generated" };
	const host = new LibraryAgentHost({ tools: [generate], models: createModels() });
	const names = (extension: string) => host.requireOwner().registry.snapshot().extension(extension)?.tools?.map((tool) => tool.name) ?? [];
	try {
		await host.openLibrary(path);
		const owner = host.requireOwner();
		const session = await host.createSession();
		for (const extension of ["loom.library", "loom.create"]) {
			assert.ok(names(extension).includes("comfy__generate"));
			assert.ok(!names(extension).includes("social__publish"));
		}
		await host.setTools([publish, generate]);
		assert.equal(host.requireOwner(), owner);
		for (const extension of ["loom.library", "loom.create"]) {
			assert.ok(names(extension).includes("social__publish"));
			assert.ok(names(extension).includes("comfy__generate"));
			assert.equal(owner.registry.snapshot().extension(extension)?.tools?.find((tool) => tool.name === "social__publish")?.replay, "unsafe");
		}
		assert.ok(!names("loom.retrieve").some((name) => name.includes("__")));
		await host.setTools([publish]);
		for (const extension of ["loom.library", "loom.create"]) {
			assert.ok(names(extension).includes("social__publish"));
			assert.ok(!names(extension).includes("comfy__generate"));
		}
		assert.equal((await host.getSession(session.id)).id, session.id);
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});

test("retrieval tools are available to the parent and retrieve specialist across live updates", async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-retrieval-"));
	const tools: LoomTool[] = ["search_assets", "inspect_asset"].map((name) => ({ name, description: name, parameters: { type: "object" }, execute: () => "found" }));
	const host = new LibraryAgentHost({ tools, models: createModels() });
	const names = (extension: string) => host.requireOwner().registry.snapshot().extension(extension)?.tools?.map((tool) => tool.name) ?? [];
	try {
		await host.openLibrary(path);
		const owner = host.requireOwner();
		for (const extension of ["loom.library", "loom.retrieve"]) {
			assert.ok(names(extension).includes("search_assets"));
			assert.ok(names(extension).includes("inspect_asset"));
		}
		assert.ok(!names("loom.create").includes("search_assets"));
		assert.ok(names("loom.create").includes("inspect_asset"));
		for (const name of ["read", "edit", "write", "bash"]) assert.ok(names("loom.create").includes(name));
		await host.setTools([tools[1]!]);
		assert.equal(host.requireOwner(), owner);
		for (const extension of ["loom.library", "loom.retrieve"]) {
			assert.ok(!names(extension).includes("search_assets"));
			assert.ok(names(extension).includes("inspect_asset"));
		}
		assert.ok(names("loom.create").includes("inspect_asset"));
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});

test("app fork-before switches context, archives source, and hides deletion without breaking ancestry", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-"));
	const host = new LibraryAgentHost({ models: createModels() });
	try {
		await host.openLibrary(path);
		const record = await host.createSession();
		await host.setSessionName(record.id, "Project");
		assert.equal(record.context, undefined, "no Chat model means no context indicator");
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

test("compaction and reopen preserve paginated chat history and forks before compacted messages", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-history-"));
	const runtime = await testChatRuntime("http://localhost/v1");
	const host = new LibraryAgentHost({ models: runtime.models, chatDefault: { provider: runtime.providerId, modelId: runtime.modelId, thinkingLevel: "off" } });
	try {
		await host.openLibrary(path);
		const session = await host.createSession();
		const conversation = await host.conversation(session.id);
		const entries = await conversation.commit(async (tx) => {
			const rows = [];
			for (let i = 0; i < 270; i++) rows.push(await tx.appendEntry(conversation.id, {
				kind: "loom.user", data: { text: `question ${i}` },
				model: [{ role: "user", content: `question ${i}: ${"history ".repeat(200)}`, timestamp: Date.now() + i }],
			}));
			return rows;
		}, context);
		host.requireOwner().registry.install(defineExtension({ name: "test.summary", hooks: [hook(CompactionTask, {
			beforeCompact: async () => ({ summary: "Earlier questions summarized." }),
		})] }));
		await conversation.configure({ extensions: { add: [{ name: "test.summary" }] } }, context);
		const beforeUsage = (await host.getSession(session.id)).context!;
		const task = await conversation.compact(undefined, context);
		assert.equal((await host.requireOwner().harness.waitForTask(task, context)).state.outcome.status, "completed");
		await conversation.waitForIdle(context);
		const active = await conversation.context(context);
		assert.ok(active.head, "a real compaction head must be placed");
		assert.ok(!active.entries.some((entry) => entry.id === entries[1]!.id), "old question must leave model context");
		const afterUsage = (await host.getSession(session.id)).context!;
		assert.ok(afterUsage.tokens! < beforeUsage.tokens!, "UI context must shrink even though history is retained");
		assert.equal(afterUsage.percent, afterUsage.tokens! / afterUsage.window * 100);
		const expectedIds = entries.map((entry) => String(entry.id));
		assert.deepEqual((await host.getSession(session.id)).messages.map((message) => message.id), expectedIds);
		assert.equal((await host.listSessions())[0]?.updatedAt, (await host.getSession(session.id)).updatedAt);
		await host.close(); await host.openLibrary(path);
		assert.deepEqual((await host.getSession(session.id)).messages.map((message) => message.id), expectedIds);
		assert.deepEqual((await host.getSession(session.id)).context, afterUsage);
		const fork = await host.forkBefore(session.id, String(entries[1]!.id));
		assert.deepEqual(fork.messages.map((message) => message.id), expectedIds.slice(0, 1));
		assert.equal(fork.messages[0]?.displayContent, "question 0");
		const empty = await host.forkBefore(session.id, String(entries[0]!.id));
		assert.deepEqual(empty.messages, []);
		await host.deleteSession(session.id);
		await host.close(); await host.openLibrary(path);
		assert.deepEqual((await host.getSession(fork.id)).messages.map((message) => message.id), expectedIds.slice(0, 1));
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});

test("closing empty conversations hides them, while sent or inherited history remains archived", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-empty-close-"));
	const host = new LibraryAgentHost({ models: createModels() });
	try {
		await host.openLibrary(path);
		const empty = await host.createSession();
		await host.setSessionName(empty.id, "Named but unused");
		const blank = await host.conversation(empty.id);
		await blank.commit((tx) => tx.appendEntry(blank.id, { kind: "test.system", model: [{ role: "system", content: "internal prompt", timestamp: 1 }] }), context);
		await host.archiveSession(empty.id);
		assert.equal((await host.listSessions()).some((row) => row.id === empty.id), false);

		const used = await host.createSession();
		const conversation = await host.conversation(used.id);
		const first = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "loom.user", data: { text: "sent" }, model: [{ role: "user", content: "sent", timestamp: 2 }] }), context);
		const second = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "loom.user", data: { text: "next" }, model: [{ role: "user", content: "next", timestamp: 3 }] }), context);
		const fork = await host.forkBefore(used.id, String(second.id));
		const emptyFork = await host.forkBefore(used.id, String(first.id));
		await host.archiveSession(used.id); await host.archiveSession(fork.id); await host.archiveSession(emptyFork.id);
		assert.deepEqual((await host.listSessions()).map((row) => ({ id: row.id, status: row.status })), [{ id: fork.id, status: "archived" }, { id: used.id, status: "archived" }]);
		await host.close(); await host.openLibrary(path);
		assert.equal((await host.listSessions()).some((row) => row.id === empty.id || row.id === emptyFork.id), false);
		assert.equal((await host.getSession(fork.id)).messages[0]?.displayContent, "sent");
		await host.unarchiveSession(used.id);
		assert.equal((await host.getSession(used.id)).status, "open");
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});

test("instruction edits apply to both existing and subsequently created conversations; model defaults affect new sessions only", async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-defaults-"));
	const runtime = await testChatRuntime("http://localhost/v1");
	const host = new LibraryAgentHost({ models: runtime.models, chatDefault: { provider: runtime.providerId, modelId: runtime.modelId, thinkingLevel: "off" } });
	try {
		await host.openLibrary(path);
		const first = await host.createSession();
		await host.setInstructions("Updated instructions");
		const secondRuntime = await testChatRuntime("http://localhost/v1", { model: "next-model", contextWindow: 64_000, providerId: "test-next", models: runtime.models });
		host.setChatDefault({ provider: secondRuntime.providerId, modelId: secondRuntime.modelId, thinkingLevel: "off" });
		const next = await host.createSession();
		const agent = await (await host.conversation(next.id)).agent(context);
		assert.equal(agent.instructions, "Updated instructions");
		assert.equal(agent.model?.modelId, "next-model");
		assert.deepEqual((await host.getSession(next.id)).context, { tokens: 0, window: 64_000, percent: 0 });
		assert.equal((await (await host.conversation(first.id)).agent(context)).model?.modelId, runtime.modelId);
		// Defaults only steer new conversations; clearing them never rewrites existing ones.
		assert.deepEqual((await host.getSession(first.id)).context, { tokens: 0, window: 128_000, percent: 0 });
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});

test("setSessionModel persists per-conversation selection, rejects while busy, and survives reopen", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-model-"));
	const runtime = await testChatRuntime("http://localhost/v1");
	const host = new LibraryAgentHost({ models: runtime.models, chatDefault: { provider: runtime.providerId, modelId: runtime.modelId, thinkingLevel: "off" } });
	try {
		await host.openLibrary(path);
		const first = await host.createSession();
		assert.deepEqual((await host.getSession(first.id)).model, { provider: "test-chat", modelId: "demo", thinkingLevel: "off" });
		// A second provider in the same collection; switching affects only this conversation.
		const second = await testChatRuntime("http://localhost/v1", { model: "other", providerId: "test-other", models: runtime.models });
		const record = await host.setSessionModel(first.id, { provider: second.providerId, modelId: second.modelId });
		assert.equal(record.model?.provider, "test-other");
		const fresh = await host.createSession();
		assert.equal((await host.getSession(fresh.id)).model?.provider, "test-chat");
		await host.close(); await host.openLibrary(path);
		assert.equal((await host.getSession(first.id)).model?.modelId, "other");
		assert.equal((await host.getSession(fresh.id)).model?.modelId, "demo");
	} finally { await host.close(); await rm(path, { recursive: true, force: true }); }
});

test("setSessionModel rejects while a request is streaming", { timeout: 10_000 }, async () => {
	const path = await mkdtemp(join(tmpdir(), "loom-host-model-busy-"));
	// A local server that holds the SSE stream open until released.
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = createServer((_request, response) => {
		entered.resolve();
		response.writeHead(200, { "content-type": "text/event-stream" });
		void release.promise.then(() => response.end('data: {"id":"r","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const runtime = await testChatRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
	const host = new LibraryAgentHost({ models: runtime.models, chatDefault: { provider: runtime.providerId, modelId: runtime.modelId, thinkingLevel: "off" } });
	try {
		await host.openLibrary(path);
		const session = await host.createSession();
		const conversation = await host.conversation(session.id);
		const submission = await conversation.submit({ type: "input", content: "work" }, context);
		await entered.promise;
		await assert.rejects(() => host.setSessionModel(session.id, { provider: runtime.providerId, modelId: runtime.modelId }), /busy/i);
		release.resolve();
		assert.equal((await submission.wait(context)).status, "done");
		// Settled work no longer blocks the change.
		await host.setSessionModel(session.id, { provider: runtime.providerId, modelId: runtime.modelId, thinkingLevel: "off" });
	} finally {
		release.resolve();
		await host.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { recursive: true, force: true });
	}
});
