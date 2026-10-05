import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HarnessSessionManager } from "../src/harness-session-manager.ts";
import type { LoomAgentEvent } from "../src/types.ts";

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function stop(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sseText(text: string): string {
	return (
		`data: ${JSON.stringify({ id: "text", object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
		`data: ${JSON.stringify({ id: "text", object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
		"data: [DONE]\n\n"
	);
}

function writeStream(path: string, content: string): string {
	const argumentsJson = JSON.stringify({ path, content }).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	return (
		`data: {"id":"tool","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"write","arguments":"${argumentsJson}"}}]},"finish_reason":null}]}\n\n` +
		`data: {"id":"tool","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
		"data: [DONE]\n\n"
	);
}

describe("tool permission gate", () => {
	it("pauses write until approve, and full access skips the gate", { timeout: 20_000 }, async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			requests += 1;
			response.end(requests % 2 === 1 ? writeStream("gated.md", requests === 1 ? "hello" : "again") : sseText("done"));
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-tool-gate-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			manager.setPermissionLevel("basic");
			const session = await manager.createSession();
			const events: LoomAgentEvent[] = [];
			let resolvePending!: (id: string) => void;
			const pending = new Promise<string>((resolve) => { resolvePending = resolve; });
			const first = manager.prompt(session.id, "write a file", {
				onEvent(event) {
					events.push(event);
					if (event.type === "tool_pending") resolvePending(event.toolCallId);
				},
			});
			const toolCallId = await pending;
			await assert.rejects(() => readFile(join(root, "gated.md"), "utf8"));
			assert.equal(manager.resolveToolGate(toolCallId, "approve"), true);
			await first;
			assert.match(await readFile(join(root, "gated.md"), "utf8"), /hello/);
			assert.ok(events.some((event) => event.type === "tool_end" && event.name === "write" && !event.isError));

			manager.setPermissionLevel("full");
			const fullEvents: LoomAgentEvent[] = [];
			await manager.prompt(session.id, "write again", { onEvent: (event) => fullEvents.push(event) });
			assert.equal(fullEvents.some((event) => event.type === "tool_pending"), false);
			assert.match(await readFile(join(root, "gated.md"), "utf8"), /again/);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("skip blocks the write and does not create the file", { timeout: 20_000 }, async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			requests += 1;
			response.end(requests % 2 === 1 ? writeStream("skipped.md", "nope") : sseText("skipped"));
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-tool-skip-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			manager.setPermissionLevel("basic");
			const session = await manager.createSession();
			const events: LoomAgentEvent[] = [];
			let resolvePending!: (id: string) => void;
			const pending = new Promise<string>((resolve) => { resolvePending = resolve; });
			const run = manager.prompt(session.id, "write a file", {
				onEvent(event) {
					events.push(event);
					if (event.type === "tool_pending") resolvePending(event.toolCallId);
				},
			});
			assert.equal(manager.resolveToolGate(await pending, "reject"), true);
			await run;
			await assert.rejects(() => readFile(join(root, "skipped.md"), "utf8"));
			const ended = events.find((event) => event.type === "tool_end");
			assert.equal(ended?.type, "tool_end");
			if (ended?.type === "tool_end") assert.equal(ended.isError, true);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});

	it("standard writes inside the library and waits outside it", { timeout: 20_000 }, async () => {
		let next: "inside" | "outside" | "text" = "inside";
		const outside = join(tmpdir(), `loom-tool-gate-outside-${Date.now()}.md`);
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (next === "text") {
				response.end(sseText("done"));
				return;
			}
			const writing = next;
			next = "text";
			response.end(writeStream(writing === "inside" ? "inside.md" : outside, writing));
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-tool-gate-std-"));
		const manager = new HarnessSessionManager({ chat: { baseUrl, apiKey: "test", model: "demo" } });
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			const insideEvents: LoomAgentEvent[] = [];
			await manager.prompt(session.id, "write inside", { onEvent: (event) => insideEvents.push(event) });
			assert.equal(insideEvents.some((event) => event.type === "tool_pending"), false);
			assert.equal(await readFile(join(root, "inside.md"), "utf8"), "inside");

			next = "outside";
			const outsideEvents: LoomAgentEvent[] = [];
			let resolvePending!: (id: string) => void;
			const pending = new Promise<string>((resolve) => { resolvePending = resolve; });
			const run = manager.prompt(session.id, "write outside", {
				onEvent(event) {
					outsideEvents.push(event);
					if (event.type === "tool_pending") resolvePending(event.toolCallId);
				},
			});
			assert.equal(manager.resolveToolGate(await pending, "reject"), true);
			await run;
			await assert.rejects(() => readFile(outside, "utf8"));
			assert.ok(outsideEvents.some((event) => event.type === "tool_pending"));
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await rm(outside, { force: true });
			await stop(server);
		}
	});
});
