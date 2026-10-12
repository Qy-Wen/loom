import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, timeout, toArray } from "rxjs";
import { LibraryAgentHost } from "../src/main/library-agent-host.ts";
import { LoomAgUiAgent } from "../src/main/ag-ui-agent.ts";
import { DurableAgentRunner } from "../src/main/durable-agent-runner.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT as context, CompactionTask, defineExtension, hook, contextUsage } from "@loom/agent";
import type { AddressInfo } from "node:net";

async function fixture(run: (host: LibraryAgentHost, adapter: LoomAgUiAgent) => Promise<void>, respond?: (request: IncomingMessage, response: ServerResponse) => void) {
	const directory = await mkdtemp(join(tmpdir(), "loom-ag-ui-"));
	const server = createServer((_request, response) => {
		if (respond) { respond(_request, response); return; }
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end('data: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const host = new LibraryAgentHost({ chat: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: "demo", apiKey: "test" } });
	try { await host.openLibrary(directory); await run(host, new LoomAgUiAgent(host)); }
	finally { await host.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}
const input = (threadId: string): RunAgentInput => ({ threadId, runId: `run-${threadId}`, messages: [{ id: "user", role: "user", content: "question" }], state: {}, tools: [], context: [], forwardedProps: {} });

test("durable AG-UI adapter produces text, committed IDs, snapshots, and a finished run", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		const events = await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
		assert.equal(events[0]?.type, EventType.RUN_STARTED);
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
		assert.ok(events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT));
		assert.ok(events.some((event) => event.type === EventType.CUSTOM && (event as { name?: string }).name === "loom.user_entry"));
		assert.ok(events.some((event) => event.type === EventType.MESSAGES_SNAPSHOT));
		assert.equal((await host.getSession(session.id)).messages.length, 2);
		assert.equal((await host.getSession(session.id)).title, "question");
	});
});

test("context reports provider usage, survives reopen, and publishes window-only or disabled-model updates", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		assert.deepEqual(session.context, { tokens: 0, window: 128_000, percent: 0 });
		await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
		const usage = (await host.getSession(session.id)).context!;
		assert.deepEqual(usage, { tokens: 1020, window: 128_000, percent: 1020 / 128_000 * 100 });
		const root = host.requireOwner().libraryPath;
		await host.close(); await host.openLibrary(root);
		assert.deepEqual((await host.getSession(session.id)).context, usage);
		const updated = Promise.withResolvers<void>();
		const unsubscribe = host.subscribeSessions(() => updated.resolve());
		try {
			await host.setChat({ baseUrl: "http://localhost/v1", model: "demo", contextWindow: 64_000 });
			await updated.promise;
			assert.deepEqual((await host.getSession(session.id)).context, { ...usage, window: 64_000, percent: 1020 / 64_000 * 100 });
			await host.setChat({ baseUrl: "http://localhost/v1", model: "other", contextWindow: 32_000 });
			const conversation = await host.conversation(session.id);
			assert.deepEqual((await host.getSession(session.id)).context, contextUsage(await conversation.context(context), { provider: "loom-chat", modelId: "other" }, 32_000));
			await host.setChat(undefined);
			assert.equal((await host.getSession(session.id)).context, undefined);
		} finally { unsubscribe(); }
	}, (_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end('data: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":20,"total_tokens":1020}}\n\ndata: [DONE]\n\n');
	});
});

test("CopilotKit clones keep the host and run lifecycle", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		const events = await lastValueFrom(adapter.clone().run(input(session.id)).pipe(toArray()));
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
	});
});

test("AG-UI apply accepts the adapter's message lifecycle", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession(); adapter.threadId = session.id; adapter.messages = input(session.id).messages;
		await adapter.runAgent({ runId: "apply" });
		assert.ok(adapter.messages.some((message) => message.role === "assistant"));
	});
});

test("resubmitting a completed durable request does not hang the AG-UI stream or duplicate messages", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
		const second = await lastValueFrom(adapter.clone().run(input(session.id)).pipe(toArray()));
		assert.equal(second.at(-1)?.type, EventType.RUN_FINISHED);
		assert.equal((await host.getSession(session.id)).messages.length, 2);
	});
});

test("completed request reconnect after compaction returns full history without waiting for a new run", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
		const conversation = await host.conversation(session.id);
		const originalIds = (await host.getSession(session.id)).messages.map((message) => message.id);
		await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "loom.user", model: [{ role: "user", content: "tail ".repeat(30_000), timestamp: Date.now() }] }), context);
		host.requireOwner().registry.install(defineExtension({ name: "test.summary", hooks: [hook(CompactionTask, { beforeCompact: async () => ({ summary: "First exchange summarized." }) })] }));
		await conversation.configure({ extensions: { add: [{ name: "test.summary" }] } }, context);
		const task = await conversation.compact(undefined, context);
		assert.equal((await host.requireOwner().harness.waitForTask(task, context)).state.outcome.status, "completed");
		await conversation.waitForIdle(context);
		assert.ok(!(await conversation.context(context)).entries.some((entry) => String(entry.id) === originalIds[1]));
		const replay = await lastValueFrom(adapter.clone().run(input(session.id)).pipe(timeout(1500), toArray()));
		assert.equal(replay.at(-1)?.type, EventType.RUN_FINISHED);
		assert.deepEqual((await host.getSession(session.id)).messages.slice(0, 2).map((message) => message.id), originalIds);
		assert.equal((await host.getSession(session.id)).messages.length, 3);
	});
});

test("text is delivered while the provider is still streaming, not only at message_end", { timeout: 10_000 }, async () => {
	const nextChunk = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let providerFinished = false;
	try {
		await fixture(async (host, adapter) => {
			const session = await host.createSession();
			const firstText = Promise.withResolvers<string>();
			const updatedText = Promise.withResolvers<void>();
			let received = "";
			adapter.threadId = session.id; adapter.messages = input(session.id).messages;
			const completed = adapter.runAgent({ runId: "stream" }, { onTextMessageContentEvent: ({ event }) => {
				received += event.delta;
				firstText.resolve(event.delta);
				if (received === "first words then more") updatedText.resolve();
			} });
			try {
				const delta = await Promise.race([firstText.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("No text before provider completion")), 1500); timer.unref(); })]);
				assert.equal(delta, "first words");
				assert.equal(providerFinished, false);
				nextChunk.resolve();
				await Promise.race([updatedText.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("No incremental text before provider completion")), 1500); timer.unref(); })]);
				assert.equal(providerFinished, false);
			} finally { nextChunk.resolve(); finish.resolve(); await completed; }
			assert.equal(adapter.messages.findLast((message) => message.role === "assistant")?.content, "first words then more and last words");
		}, (_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"id":"stream","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"first words"},"finish_reason":null}]}\n\n');
			void nextChunk.promise.then(() => {
				response.write('data: {"id":"stream","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":" then more"},"finish_reason":null}]}\n\n');
			});
			void finish.promise.then(() => {
				providerFinished = true;
				response.end('data: {"id":"stream","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":" and last words"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
			});
		});
	} finally { nextChunk.resolve(); finish.resolve(); }
});

test("transport detach preserves work; durable reconnect and exact-run Stop need no memory history", { timeout: 10_000 }, async () => {
	const release = Promise.withResolvers<void>();
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		const runner = new DurableAgentRunner(host, adapter);
		const first = Promise.withResolvers<void>();
		const stream = runner.run({ threadId: session.id, agent: adapter, input: input(session.id) });
		const subscription = stream.subscribe((event) => { if (event.type === EventType.TEXT_MESSAGE_CONTENT) first.resolve(); });
		await first.promise; subscription.unsubscribe();
		assert.equal(await runner.isRunning({ threadId: session.id }), true);
		await host.archiveSession(session.id);
		assert.equal((await host.listSessions()).find((row) => row.id === session.id)?.status, "archived", "closing a busy sent conversation must keep its history");
		const fresh = new DurableAgentRunner(host, new LoomAgUiAgent(host));
		const connected = lastValueFrom(fresh.connect({ threadId: session.id }).pipe(toArray()));
		assert.equal(await fresh.stop({ threadId: session.id, runId: "another-run" }), false);
		assert.equal(await fresh.isRunning({ threadId: session.id }), true);
		assert.equal(await fresh.stop({ threadId: session.id, runId: input(session.id).runId }), true);
		const events = await connected;
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
		assert.equal(await fresh.isRunning({ threadId: session.id }), false);
		assert.equal((await host.getSession(session.id)).messages.filter((message) => message.role === "user").length, 1);
		release.resolve();
	}, (_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write('data: {"id":"stream","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"working"},"finish_reason":null}]}\n\n');
		void release.promise.then(() => { if (!response.destroyed) response.end("data: [DONE]\n\n"); });
	});
});

function reply(response: ServerResponse, tool?: string, args = {}) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	const delta = tool ? { tool_calls: [{ index: 0, id: `call-${tool}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "finished" };
	response.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
}
for (const decision of ["approve", "reject", "stop"] as const) {
	test(`AG-UI specialist ${decision} publishes and clears child approvals with namespaced call IDs`, { timeout: 10_000 }, async () => {
		await fixture(async (host, adapter) => {
			host.setPermissionLevel("basic");
			const session = await host.createSession();
			const events: import("@ag-ui/core").BaseEvent[] = [];
			adapter.threadId = session.id; adapter.messages = input(session.id).messages;
			await adapter.runAgent({ runId: input(session.id).runId }, { onEvent: ({ event, messages }) => {
				events.push(event);
				const activity = event as { activityType?: string; content?: { toolCallId?: string; pending?: boolean } };
				if (activity.activityType === "loom.tool_gate" && activity.content?.pending && activity.content.toolCallId) {
					assert.ok(messages.some((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.function.name === "write")), JSON.stringify(messages));
					if (decision === "stop") void host.conversation(session.id).then((conversation) => conversation.abort(context));
					else host.resolveToolGate(activity.content.toolCallId, decision);
				}
			} });
			assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
			if (decision === "approve") assert.equal(await readFile(join(host.requireOwner().libraryPath, "generated.txt"), "utf8"), "generated");
			else await assert.rejects(readFile(join(host.requireOwner().libraryPath, "generated.txt")), { code: "ENOENT" });
			const gates = events.filter((event) => (event as { activityType?: string }).activityType === "loom.tool_gate") as unknown as Array<{ content: { toolCallId: string; pending: boolean } }>;
			assert.ok(gates.some((event) => event.content.pending));
			assert.ok(gates.some((event) => !event.content.pending));
			assert.ok(gates.every((event) => /^\d+\//.test(event.content.toolCallId)));
			assert.equal((await host.listSessions()).length, 1);
		}, (request, response) => {
			let body = ""; request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string }> };
				const names = parsed.tools?.map((tool) => tool.function.name) ?? [];
				if (parsed.messages.some((message) => message.role === "tool")) reply(response);
				else if (names.includes("run_create_agent")) reply(response, "run_create_agent", { goal: "generate an asset" });
				else reply(response, "write", { path: "generated.txt", content: "generated" });
			});
		});
	});
}
