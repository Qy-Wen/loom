import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, timeout, toArray, type Subscription } from "rxjs";
import { ChatService } from "../src/main/chat/chat-service.ts";
import { testChatRuntime } from "./fixtures/test-chat-runtime.ts";
import { AgUiAdapter } from "../src/main/chat/ag-ui-adapter.ts";
import { DurableAgentRunner } from "../src/main/chat/durable-agent-runner.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT as context, CompactionTask, defineExtension, hook } from "@loom/agent";
import type { ConversationId } from "@loom/agent";
import type { AddressInfo } from "node:net";
import { McpHost } from "../src/main/mcp/host.ts";
import { toAgUiMessages } from "../src/shared/ag-ui-messages.ts";
import { toolResultParts } from "../src/shared/tool-result-content.ts";

async function fixture(run: (host: ChatService, adapter: AgUiAdapter) => Promise<void>, respond?: (request: IncomingMessage, response: ServerResponse) => void) {
	const directory = await mkdtemp(join(tmpdir(), "loom-ag-ui-"));
	const server = createServer((_request, response) => {
		if (respond) { respond(_request, response); return; }
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end('data: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"reply","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const runtime = await testChatRuntime(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
	const host = new ChatService({ models: runtime.models, chatDefault: { provider: runtime.providerId, modelId: runtime.modelId, thinkingLevel: "off" } });
	try { await host.openLibrary(directory); await run(host, new AgUiAdapter(host)); }
	finally { await host.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
}
const input = (threadId: string): RunAgentInput => ({ threadId, runId: `run-${threadId}`, messages: [{ id: "user", role: "user", content: "question" }], state: {}, tools: [], context: [], forwardedProps: {} });

for (const caller of ["main", "retrieve", "create"] as const) {
	test(`large ${caller} results use shared storage and survive fork/reopen`, { timeout: 10_000 }, async () => {
		const full = "result line\n".repeat(6_000) + "END_FULL_OUTPUT";
		const toolName = caller === "retrieve" ? "search_assets" : "fixture__large";
		let receivedPreview = false;
		await fixture(async (host, adapter) => {
			await host.setTools([{ name: toolName, description: "Large result", parameters: { type: "object", properties: {} }, execute: () => full }]);
			host.setPermissionLevel("full");
			const session = await host.createSession();
			const events = await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
			assert.ok(receivedPreview, "provider must receive a bounded preview and the full-output path");
			const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT && "content" in event && String(event.content).includes("Full output:"));
			assert.ok(result && "content" in result && "toolCallId" in result);
			const path = /Full output: ([^\n]+)/.exec(String(result.content))?.[1];
			assert.ok(path);
			assert.equal(await readFile(path, "utf8"), full);
			const owner = host.requireRuntime();
			const conversationId = Number(String(result.toolCallId).split("/")[0]) as ConversationId;
			assert.equal(path.startsWith(join(owner.libraryPath, ".loom", "agents", "tool-results", String(conversationId))), true);
			const conversation = await owner.harness.conversation(conversationId, context);
			assert.ok(conversation);
			const at = (await conversation.entries({}, 1, undefined, context)).items[0]!.id;
			const fork = await conversation.fork(at, { ownership: { kind: "ownerless" } }, context);
			assert.ok(JSON.stringify((await fork.context(context)).messages).includes(path.replaceAll("\\", "\\\\")));
			const root = owner.libraryPath;
			await host.close();
			await host.openLibrary(root);
			assert.equal(await readFile(path, "utf8"), full);
			assert.ok(JSON.stringify((await host.getSession(String(fork.id))).messages).includes(path.replaceAll("\\", "\\\\")));
		}, (request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> };
				const results = parsed.messages.filter((message) => message.role === "tool");
				if (results.length > 0) {
					const content = JSON.stringify(results);
					assert.ok(!content.includes("END_FULL_OUTPUT"));
					if (content.includes("Full output:")) {
						receivedPreview = true;
						assert.ok(content.length < 8 * 1024);
					}
					reply(response);
				} else if (caller !== "main" && parsed.tools?.some((tool) => tool.function.name === `run_${caller}_agent`)) {
					reply(response, `run_${caller}_agent`, { goal: `Call ${toolName} for this task` });
				} else reply(response, toolName);
			});
		});
	});
}

for (const caller of ["main", "create"] as const) {
	test(`MCP images reach the ${caller} model, live tool results, and persisted history`, { timeout: 10_000 }, async () => {
		const data = (await readFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url))).toString("base64");
		let receivedImage = false;
		await fixture(async (host, adapter) => {
			const mcp = new McpHost();
			try {
				const tools = await mcp.connect([{ id: "fixture", command: process.execPath, args: ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/mcp-image-server.ts", import.meta.url))], enabled: true }]);
				assert.equal(tools.length, 1);
				await host.setTools(tools);
				host.setPermissionLevel("full");
				const session = await host.createSession();
				const events = await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
				assert.ok(receivedImage, "the provider request must contain an image_url content part");
				const imageResult = events.find((event) => event.type === EventType.TOOL_CALL_RESULT && "content" in event && toolResultParts(event.content));
				assert.ok(imageResult && "content" in imageResult && "toolCallId" in imageResult);
				const parts = toolResultParts(imageResult.content)!;
				const image = parts.find((part) => part.type === "image");
				assert.ok(image && "url" in image);
				const imageUrl = new URL(image.url);
				const [conversationId, entryId, contentIndex] = imageUrl.pathname.slice(1).split("/");
				assert.equal((await host.getChatImage(conversationId!, entryId!, Number(contentIndex)))?.data, data);
				const resultConversation = String(imageResult.toolCallId).split("/")[0]!;
				const root = host.requireRuntime().libraryPath;
				await host.close(); await host.openLibrary(root);
				const messages = toAgUiMessages((await host.getSession(resultConversation)).messages);
				const restored = messages.find((message) => message.role === "tool" && toolResultParts(message.content));
				assert.ok(restored && "content" in restored);
				assert.ok(toolResultParts(restored.content)?.some((part) => part.type === "image" && "data" in part && part.data === data));
			} finally { await mcp.close(); }
		}, (request, response) => {
			let body = "";
			request.setEncoding("utf8"); request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				const parsed = JSON.parse(body) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> };
				if (parsed.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part?.type === "image_url" && part.image_url?.url === `data:image/png;base64,${data}`))) receivedImage = true;
				if (parsed.messages.some((message) => message.role === "tool")) reply(response);
				else if (caller === "create" && parsed.tools?.some((tool) => tool.function.name === "run_create_agent")) reply(response, "run_create_agent", { goal: "Get an image from fixture__image" });
				else reply(response, "fixture__image");
			});
		});
	});
}

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

test("saved history stays off the live stream and incremental reads return only new committed entries", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		const conversation = await host.conversation(session.id);
		await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "LEGACY_HISTORY_".repeat(1000), timestamp: 1 }] }), context);
		const history = await host.getSession(session.id);
		const tail = String(history.messages.at(-1)!.id);
		assert.deepEqual((await host.getSession(session.id, tail)).messages, []);
		const events = await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
		assert.equal(JSON.stringify(events).includes("LEGACY_HISTORY_"), false);
		assert.ok(JSON.stringify(events).length < 10_000);
		const delta = await host.getSession(session.id, tail);
		assert.deepEqual(delta.messages.map((message) => message.role), ["user", "assistant"]);
		assert.equal(delta.messages[0]?.clientMessageId, "user");
		assert.deepEqual((await host.getSession(session.id, String(delta.messages.at(-1)!.id))).messages, []);
		const connected = await lastValueFrom(adapter.connectThread(session.id).pipe(toArray()));
		assert.equal(JSON.stringify(connected).includes("LEGACY_HISTORY_"), false);
	});
});

test("trace persists streaming increments before completion and reloads from the library", { timeout: 10_000 }, async () => {
	const finish = Promise.withResolvers<void>();
	const published = Promise.withResolvers<void>();
	await fixture(async (host) => {
		await host.close();
		const updates: import("@loom/agent").LoomTraceRecord[] = [];
		let resets = 0;
		host.setTracePublisher((record) => { if (!record) { resets++; return; } updates.push(record); if (record.status === "running" && record.spans.some((span) => String(span.attributes["loom.io.output"]).includes("trace partial"))) published.resolve(); });
		const root = await mkdtemp(join(tmpdir(), "loom-app-trace-"));
		try {
			await host.openLibrary(root);
			const session = await host.createSession();
			const adapter = new AgUiAdapter(host);
			const run = lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
			try {
				await Promise.race([published.promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("No live trace before completion")), 2000); timer.unref(); })]);
				assert.equal(host.listTraces()[0]!.status, "running");
			} finally { finish.resolve(); await run; }
			// Native phase spans unwind after their decision commit becomes visible.
			await host.requireRuntime().harness.waitForIdle(context);
			await new Promise<void>(setImmediate);
			const records = host.listTraces(); assert.equal(records.length, 1); assert.equal(records[0]!.status, "completed");
			assert.ok(updates.length > 1);
			await host.close(); await host.openLibrary(root);
			assert.deepEqual(host.listTraces(), records);
			assert.ok(resets >= 2);
			const secondLibrary = await mkdtemp(join(tmpdir(), "loom-app-trace-switch-"));
			try { await host.openLibrary(secondLibrary); assert.deepEqual(host.listTraces(), []); }
			finally { await host.close(); await rm(secondLibrary, { recursive: true, force: true }); }
			await host.openLibrary(root); assert.deepEqual(host.listTraces(), records);
		} finally { finish.resolve(); await host.close(); await rm(root, { recursive: true, force: true }); }
	}, (_request, response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write('data: {"id":"trace","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"trace partial"},"finish_reason":null}]}\n\n');
		void finish.promise.then(() => response.end('data: {"id":"trace","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
	});
});

test("context reports provider usage, survives reopen, and publishes window-only or disabled-model updates", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		assert.deepEqual(session.context, { tokens: 0, window: 128_000, percent: 0 });
		await lastValueFrom(adapter.run(input(session.id)).pipe(toArray()));
		const usage = (await host.getSession(session.id)).context!;
		assert.deepEqual(usage, { tokens: 1020, window: 128_000, percent: 1020 / 128_000 * 100 });
		const root = host.requireRuntime().libraryPath;
		await host.close(); await host.openLibrary(root);
		assert.deepEqual((await host.getSession(session.id)).context, usage);
		// Defaults steer only new conversations; usage on existing ones is never rewritten.
		assert.deepEqual((await host.getSession(session.id)).context, usage);
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
		host.requireRuntime().registry.install(defineExtension({ name: "test.summary", hooks: [hook(CompactionTask, { beforeCompact: async () => ({ summary: "First exchange summarized." }) })] }));
		await conversation.configure({ extensions: { add: [{ name: "test.summary" }] } }, context);
		const task = await conversation.compact(undefined, context);
		assert.equal((await host.requireRuntime().harness.waitForTask(task, context)).state.outcome.status, "completed");
		await conversation.waitForIdle(context);
		assert.ok(!(await conversation.context(context)).entries.some((entry) => String(entry.id) === originalIds[1]));
		const replay = await lastValueFrom(adapter.clone().run(input(session.id)).pipe(timeout(1500), toArray()));
		assert.equal(replay.at(-1)?.type, EventType.RUN_FINISHED);
		assert.deepEqual((await host.getSession(session.id)).messages.slice(0, 2).map((message) => message.id), originalIds);
		assert.equal((await host.getSession(session.id)).messages.length, 3);
	});
});

test("queued follow-ups stay one at a time and keep streaming after the first answer", { timeout: 15_000 }, async () => {
	const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let requests = 0;
	try {
		await fixture(async (host, adapter) => {
			const session = await host.createSession();
			const events: import("@ag-ui/core").BaseEvent[] = [];
			let finished = false;
			const completed = Promise.withResolvers<void>();
			const reconnectEvents: import("@ag-ui/core").BaseEvent[] = [];
			const reconnected = Promise.withResolvers<void>();
			let reconnectFinished = false;
			let reconnect: Subscription | undefined;
			const subscription = adapter.run(input(session.id)).subscribe({
				next: (event) => { events.push(event); },
				error: (error) => completed.reject(error instanceof Error ? error : new Error(String(error))),
				complete: () => { finished = true; completed.resolve(); },
			});
			const text = () => events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => (event as { delta?: string }).delta ?? "").join("");
			const waitFor = async (snippet: string) => {
				const start = Date.now();
				while (!text().includes(snippet)) {
					if (finished) throw new Error(`Run finished before ${snippet}: ${text()}`);
					if (Date.now() - start > 4_000) throw new Error(`Missing ${snippet} in ${text()}`);
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			};
			try {
				await waitFor("A-partial");
				reconnect = adapter.clone().connectThread(session.id).subscribe({
					next: (event) => { reconnectEvents.push(event); },
					error: (error) => reconnected.reject(error),
					complete: () => { reconnectFinished = true; reconnected.resolve(); },
				});
				const conversation = await host.conversation(session.id);
				await conversation.submit({ type: "input", content: "second", whenBusy: "followUp" }, context);
				await conversation.submit({ type: "input", content: "third", whenBusy: "followUp" }, context);
				release[0]!.resolve();
				await waitFor("B-partial");
				assert.equal(finished, false);
				assert.equal(reconnectFinished, false);
				assert.equal(requests, 2);
				const inspection = await host.requireRuntime().harness.inspect(context);
				const queued = inspection.submissions.filter((row) => row.conversationId === conversation.id && row.type === "input" && row.status === "queued");
				assert.equal(queued.length, 1);
				release[1]!.resolve();
				await waitFor("C-partial");
				assert.equal(finished, false);
				assert.equal(reconnectFinished, false);
				assert.equal(requests, 3);
				release[2]!.resolve();
				await Promise.all([completed.promise, reconnected.promise]);
				assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
				assert.equal(events.filter((event) => event.type === EventType.RUN_FINISHED).length, 1);
				assert.match(text(), /A-partialA-done/);
				assert.match(text(), /B-partialB-done/);
				assert.match(text(), /C-partialC-done/);
				assert.equal(reconnectEvents.at(-1)?.type, EventType.RUN_FINISHED);
				const reconnectText = reconnectEvents.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT).map((event) => (event as { delta?: string }).delta ?? "").join("");
				assert.match(reconnectText, /B-partialB-done/);
				assert.match(reconnectText, /C-partialC-done/);
				const messages = (await host.getSession(session.id)).messages;
				assert.equal(messages.filter((message) => message.role === "user").length, 3);
				assert.equal(messages.filter((message) => message.role === "assistant").length, 3);
			} finally {
				for (const gate of release) gate.resolve();
				subscription.unsubscribe();
				reconnect?.unsubscribe();
			}
		}, (request, response) => {
			request.resume();
			request.on("end", () => {
				const turn = requests++;
				const label = ["A", "B", "C"][turn] ?? "Z";
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(`data: ${JSON.stringify({ id: label, object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: `${label}-partial` }, finish_reason: null }] })}\n\n`);
				void (release[turn] ?? release[2]!).promise.then(() => {
					if (response.writableEnded || response.destroyed) return;
					response.end(`data: ${JSON.stringify({ id: label, object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: `${label}-done` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
				});
			});
		});
	} finally {
		for (const gate of release) gate.resolve();
	}
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
		const fresh = new DurableAgentRunner(host, new AgUiAdapter(host));
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
			if (decision === "approve") assert.equal(await readFile(join(host.requireRuntime().libraryPath, "generated.txt"), "utf8"), "generated");
			else await assert.rejects(readFile(join(host.requireRuntime().libraryPath, "generated.txt")), { code: "ENOENT" });
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

test("native transcript paging preserves entries when a live window drops an entire batch", { timeout: 10_000 }, async () => {
	const finish = Promise.withResolvers<void>();
	const partial = Promise.withResolvers<void>();
	try {
		await fixture(async (host, adapter) => {
			const session = await host.createSession();
			const events: import("@ag-ui/core").BaseEvent[] = [];
			const complete = Promise.withResolvers<void>();
			const subscription = adapter.run(input(session.id)).subscribe({
				next: (event) => { events.push(event); if (event.type === EventType.TEXT_MESSAGE_CONTENT) partial.resolve(); },
				error: complete.reject,
				complete: () => complete.resolve(),
			});
			try {
				await partial.promise;
				const conversation = await host.conversation(session.id);
				await conversation.commit(async (tx) => {
					for (let i = 0; i < 130; i++) await tx.appendEntry(conversation.id, { kind: "loom.user", model: [{ role: "user", content: `BULK_${i}`, timestamp: i }] });
				}, context);
				finish.resolve();
				await complete.promise;
				assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
				const rows = events.filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && "delta" in event && String(event.delta).startsWith("BULK_"));
				assert.deepEqual(rows.map((event) => "delta" in event ? event.delta : undefined), Array.from({ length: 130 }, (_, i) => `BULK_${i}`));
			} finally { finish.resolve(); subscription.unsubscribe(); }
		}, (_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"id":"window","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
			void finish.promise.then(() => response.end('data: {"id":"window","object":"chat.completion.chunk","model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
		});
	} finally { finish.resolve(); }
});
