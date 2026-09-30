import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentHarness, BACKGROUND_CONTEXT, JsonlSessionRepo } from "#vendor/pi-agent";
import { NodeExecutionEnv } from "#vendor/pi-agent/node";
import { Type } from "@earendil-works/pi-ai";
import { HarnessSessionManager } from "../src/harness-session-manager.ts";
import { buildChatModels, chatEndpointReady, toProviderMessages } from "../src/pi-adapter.ts";
import type { LoomAgentEvent } from "../src/types.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function stop(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function sessionFile(root: string): Promise<string> {
	const sessionsRoot = join(root, ".loom", "harness-sessions");
	const directories = await readdir(sessionsRoot);
	assert.equal(directories.length, 1);
	const files = await readdir(join(sessionsRoot, directories[0]!));
	assert.equal(files.length, 1);
	return join(sessionsRoot, directories[0]!, files[0]!);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => { resolve = settle; });
	return { promise, resolve };
}

describe("HarnessSessionManager", () => {
	it("stores format-4 sessions without touching legacy v1 sessions, including name and archive state", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-harness-session-"));
		const legacyDirectory = join(root, ".loom", "sessions");
		const legacyFile = join(legacyDirectory, "legacy.jsonl");
		const legacy = '{"version":1,"id":"legacy"}\n';
		const manager = new HarnessSessionManager({});
		try {
			await mkdir(legacyDirectory, { recursive: true });
			await writeFile(legacyFile, legacy);
			await manager.openLibrary(root);
			assert.deepEqual(await manager.listSessions(), []);
			const created = await manager.createSession();
			assert.equal(created.title, "New session");
			assert.equal(created.status, "open");
			assert.deepEqual(created.messages, []);

			const header = JSON.parse((await readFile(await sessionFile(root), "utf8")).split("\n")[0]!);
			assert.equal(header.kind, "header");
			assert.equal(header.v, 4);
			assert.equal(header.id, created.id);

			await manager.setSessionName(created.id, "My project");
			await manager.archiveSession(created.id);
			assert.deepEqual((await manager.listSessions()).map(({ id, title, status }) => ({ id, title, status })), [
				{ id: created.id, title: "My project", status: "archived" },
			]);
			await manager.close();
			const reopened = new HarnessSessionManager({});
			try {
				await reopened.openLibrary(root);
				assert.equal((await reopened.openSession(created.id)).title, "My project");
				assert.equal((await reopened.getSession(created.id)).status, "archived");
				await reopened.unarchiveSession(created.id);
				assert.equal((await reopened.listSessions())[0]?.status, "open");
				await reopened.deleteSession(created.id);
				assert.deepEqual(await reopened.listSessions(), []);
			} finally {
				await reopened.close();
			}
			assert.equal(await readFile(legacyFile, "utf8"), legacy);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("supports concurrent session reads while the session has no live handle", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-harness-concurrent-"));
		const manager = new HarnessSessionManager({});
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await manager.archiveSession(session.id);
			const [first, second, list] = await Promise.all([
				manager.getSession(session.id),
				manager.getSession(session.id),
				manager.listSessions(),
			]);
			assert.equal(first.id, session.id);
			assert.deepEqual(second, first);
			assert.deepEqual(list.map((row) => row.id), [session.id]);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("concurrently opens, lists, and reads a closed session", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-harness-open-race-"));
		const manager = new HarnessSessionManager({});
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await manager.archiveSession(session.id);
			for (let round = 0; round < 20; round++) {
				const [opened, list, read] = await Promise.all([
					manager.openSession(session.id),
					manager.listSessions(),
					manager.getSession(session.id),
				]);
				assert.equal(opened.id, session.id);
				assert.equal(read.id, session.id);
				assert.deepEqual(list.map((row) => row.id), [session.id]);
				await manager.archiveSession(session.id);
			}
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("creates sessions without Chat, but rejects prompting until Chat is configured", async () => {
		const root = await mkdtemp(join(tmpdir(), "loom-harness-chat-"));
		const manager = new HarnessSessionManager({});
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await assert.rejects(manager.prompt(session.id, "hello"), /Chat is not configured/);
			assert.deepEqual((await manager.getSession(session.id)).messages, []);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("streams a response and persists the prompt across reopen", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\n');
			response.write('data: {"id":"test","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
			response.end("data: [DONE]\n\n");
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-prompt-"));
		const options = { chat: { baseUrl, apiKey: "test", model: "demo" } };
		const manager = new HarnessSessionManager(options);
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			const events: LoomAgentEvent[] = [];
			await manager.prompt(session.id, "hi", { onEvent: (event) => events.push(event) });
			assert.ok(events.some((event) => event.type === "agent_start"));
			assert.ok(events.some((event) => event.type === "text" && event.delta.includes("hello")));
			assert.ok(events.some((event) => event.type === "agent_end"));
			assert.deepEqual((await manager.getSession(session.id)).messages.map((row) => row.role), ["user", "assistant"]);
			const usage = (await manager.getSession(session.id)).context;
			assert.ok(usage);
			assert.equal(usage.window, 128000);
			assert.ok(typeof usage.tokens === "number" && usage.tokens > 0);
			assert.ok(typeof usage.percent === "number" && usage.percent > 0 && usage.percent < 100);
			await manager.close();
			const reopened = new HarnessSessionManager(options);
			try {
				await reopened.openLibrary(root);
				const stored = await reopened.openSession(session.id);
				assert.equal(stored.messages[0]?.role, "user");
				assert.match(JSON.stringify(stored.messages[1]?.content), /hello/);
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("does not submit or store a prompt stopped during preflight", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("data: [DONE]\n\n");
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-early-stop-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			const run = manager.prompt(session.id, "never submit");
			await manager.abort(session.id, "user");
			await run;
			assert.equal(requests, 0);
			assert.deepEqual((await manager.getSession(session.id)).messages, []);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("close cancels a prompt in preflight without persisting or submitting it", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("data: [DONE]\n\n");
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-close-"));
		const options = { chat: { baseUrl, apiKey: "test", model: "demo" } };
		const manager = new HarnessSessionManager(options);
		const reopened = new HarnessSessionManager(options);
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			const run = manager.prompt(session.id, "never submit");
			await manager.close();
			await run;
			assert.equal(requests, 0);
			await reopened.openLibrary(root);
			assert.deepEqual((await reopened.openSession(session.id)).messages, []);
			assert.equal(requests, 0);
		} finally {
			await manager.close();
			await reopened.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("switching libraries cancels an in-flight prompt in preflight", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("data: [DONE]\n\n");
		});
		const baseUrl = await listen(server);
		const firstRoot = await mkdtemp(join(tmpdir(), "loom-harness-switch-from-"));
		const secondRoot = await mkdtemp(join(tmpdir(), "loom-harness-switch-to-"));
		const options = { chat: { baseUrl, apiKey: "test", model: "demo" } };
		const manager = new HarnessSessionManager(options);
		const reopened = new HarnessSessionManager(options);
		try {
			await manager.openLibrary(firstRoot);
			const session = await manager.createSession();
			const run = manager.prompt(session.id, "never submit");
			await manager.openLibrary(secondRoot);
			await run;
			assert.equal(requests, 0);
			assert.deepEqual(await manager.listSessions(), []);
			await reopened.openLibrary(firstRoot);
			assert.deepEqual((await reopened.openSession(session.id)).messages, []);
			assert.equal(requests, 0);
		} finally {
			await manager.close();
			await reopened.close();
			await rm(firstRoot, { recursive: true, force: true });
			await rm(secondRoot, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("recovers an admitted operation once without blocking library open or MCP tool updates", async () => {
		let requests = 0;
		const arrived = deferred<void>();
		const release = deferred<void>();
		const server = createServer(async (_request, response) => {
			requests++;
			arrived.resolve();
			await release.promise;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"id":"recovery","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"recovered"},"finish_reason":null}]}\n\n');
			response.write('data: {"id":"recovery","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
			response.end("data: [DONE]\n\n");
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-recovery-"));
		const chat = { baseUrl, apiKey: "test", model: "demo" };
		const setup = new HarnessSessionManager({});
		const recovered = new HarnessSessionManager({ chat });
		const reopened = new HarnessSessionManager({ chat });
		try {
			await setup.openLibrary(root);
			const session = await setup.createSession();
			await setup.close();

			const repo = new JsonlSessionRepo({
				fileSystem: new NodeExecutionEnv({ cwd: root }),
				sessionsRoot: join(root, ".loom", "harness-sessions"),
			});
			const metadata = (await repo.list({ cwd: root }, BACKGROUND_CONTEXT))[0];
			assert.ok(metadata);
			const opened = await repo.open(metadata, BACKGROUND_CONTEXT);
			const { models, model } = buildChatModels(chat);
			const { harness } = await AgentHarness.create({
				session: opened,
				models,
				model,
				toProviderMessages,
			}, BACKGROUND_CONTEXT);
			const lane = await harness.lane("main", BACKGROUND_CONTEXT);
			const admitted = await lane.accept({ kind: "prompt", prompt: "resume me" }, BACKGROUND_CONTEXT);
			assert.equal(admitted.ok, true);
			await harness.close(BACKGROUND_CONTEXT);
			await repo.close(BACKGROUND_CONTEXT);
			assert.equal(requests, 0);

			await recovered.openLibrary(root);
			await arrived.promise;
			await recovered.setTools([]);
			release.resolve();
			await recovered.waitForRecovery();
			assert.equal(requests, 1);
			const stored = await recovered.getSession(session.id);
			assert.deepEqual(stored.messages.map((message) => message.role), ["user", "assistant"]);
			assert.match(JSON.stringify(stored.messages[1]?.content), /recovered/);
			await recovered.close();
			await reopened.openLibrary(root);
			await reopened.waitForRecovery();
			assert.equal(requests, 1);
			assert.equal((await reopened.getSession(session.id)).messages.length, 2);
		} finally {
			release.resolve();
			await setup.close();
			await recovered.close();
			await reopened.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("updates Chat model and installed tools on a persisted lane", async () => {
		const models: string[] = [];
		const visibleTools: string[][] = [];
		const calls: string[] = [];
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				const payload = JSON.parse(body);
				models.push(payload.model);
				visibleTools.push((payload.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name));
				response.writeHead(200, { "content-type": "text/event-stream" });
				if (models.length === 2) {
					response.write('data: {"id":"tool","object":"chat.completion.chunk","created":0,"model":"demo2","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"echo","arguments":"{\\\"text\\\":\\\"changed\\\"}"}}]},"finish_reason":null}]}\n\n');
					response.write('data: {"id":"tool","object":"chat.completion.chunk","created":0,"model":"demo2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
				} else {
					response.write(`data: ${JSON.stringify({ id: "text", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: models.length === 1 ? "before" : "after" }, finish_reason: null }] })}\n\n`);
					response.write(`data: ${JSON.stringify({ id: "text", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
				}
				response.end("data: [DONE]\n\n");
			});
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-updates-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await manager.prompt(session.id, "before update");
			await manager.setTools([{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }), execute(args) {
				const { text } = args as { text: string };
				calls.push(text);
				return `echo: ${text}`;
			} }]);
			await manager.setChat({ baseUrl, apiKey: "test", model: "demo2" });
			const events: LoomAgentEvent[] = [];
			await manager.prompt(session.id, "use echo", { onEvent: (event) => events.push(event) });
			assert.deepEqual(models, ["demo", "demo2", "demo2"]);
			assert.ok(visibleTools[1]?.includes("echo"));
			assert.deepEqual(calls, ["changed"]);
			assert.ok(events.some((event) => event.type === "tool_end" && event.name === "echo" && !event.isError));
			assert.deepEqual((await manager.getSession(session.id)).messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "toolResult", "assistant"]);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("recovers from provider context overflow despite disabled threshold compaction", async () => {
		const requests: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				requests.push(JSON.parse(body));
				if (requests.length === 2) {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "Your input exceeds the context window of this model" } }));
					return;
				}
				const text = requests.length === 1 ? "prior answer" : requests.length === 3 ? "compacted history" : "recovered answer";
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(`data: ${JSON.stringify({ id: `overflow-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ id: `overflow-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
				response.end("data: [DONE]\n\n");
			});
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-overflow-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await manager.prompt(session.id, "archive context ".repeat(6_000));
			assert.equal(requests.length, 1);
			assert.doesNotMatch(await readFile(await sessionFile(root), "utf8"), /"type":"compaction"/);
			await manager.prompt(session.id, "continue after context overflow");
			assert.equal(requests.length, 4);
			assert.match(JSON.stringify(requests[2]?.messages), /conversation to summarize/);
			assert.match(JSON.stringify(requests[3]?.messages), /compacted history/);
			const stored = await manager.getSession(session.id);
			assert.match(JSON.stringify(stored.messages.at(-1)?.content), /recovered answer/);
			assert.match(await readFile(await sessionFile(root), "utf8"), /"type":"compaction"/);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("stops a hanging Chat stream, persists Stop, and shows the note on the next prompt", async () => {
		const arrived = [deferred<string>(), deferred<string>()];
		let requests = 0;
		const server = createServer((request, response) => {
			const index = requests++;
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				arrived[index]?.resolve(body);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(": waiting\n\n");
			});
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-stop-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			const first = manager.prompt(session.id, "stop this");
			await arrived[0]!.promise;
			await manager.abort(session.id, "user");
			await first;
			const stored = await readFile(await sessionFile(root), "utf8");
			assert.match(stored, /loom_user_stop/);

			const second = manager.prompt(session.id, "continue");
			const secondRequest = await arrived[1]!.promise;
			assert.match(secondRequest, /The user pressed Stop/);
			await manager.abort(session.id, "user");
			await second;
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});
});

describe("chatEndpointReady", () => {
	it("compacts the context once usage crosses the configured context window", async () => {
		const requests: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				requests.push(JSON.parse(body));
				// First turn: a normal answer that fills the tiny context window.
				const text = requests.length === 1 ? "a".repeat(120) : requests.length === 2 ? "summarized checkpoint" : "after compaction";
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(`data: ${JSON.stringify({ id: `compact-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
				response.write(`data: ${JSON.stringify({ id: `compact-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
				response.end("data: [DONE]\n\n");
			});
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-harness-threshold-"));
		// Tiny window: 120-char answer + prompt easily exceeds 400 - 16,384 reserve
		// would never trigger, so use a window where reserve is dominant.
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo", contextWindow: 128 } });
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			const events: LoomAgentEvent[] = [];
			// First prompt: answer fills context; threshold compaction fires at the checkpoint.
			await manager.prompt(session.id, "tell me something", { onEvent: (event) => events.push(event) });
			assert.ok(events.some((event) => event.type === "compaction_start" && event.reason === "threshold"), `expected compaction_start, got: ${events.map((e) => e.type).join(",")}`);
			assert.ok(events.some((event) => event.type === "compaction_end" && event.status === "completed"));
			const stored = await manager.getSession(session.id);
			const compaction = stored.messages.find((message) => message.role === "compactionSummary");
			assert.ok(compaction, `expected a compactionSummary entry, got roles: ${stored.messages.map((m) => m.role).join(",")}`);
			// Context usage is unknown right after compaction: no post-compaction assistant usage yet.
			assert.ok(stored.context, "expected context usage");
			assert.equal(stored.context.window, 128);
			assert.equal(stored.context.tokens, null);
			assert.equal(stored.context.percent, null);
			assert.match(await readFile(await sessionFile(root), "utf8"), /"type":"compaction"/);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("requires a trimmed base URL and model", () => {
		assert.equal(chatEndpointReady(undefined), false);
		assert.equal(chatEndpointReady({ baseUrl: "  ", model: "x" }), false);
		assert.equal(chatEndpointReady({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama" }), true);
	});
});
