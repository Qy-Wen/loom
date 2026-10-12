import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { LibraryAgentHost } from "../src/main/library-agent-host.ts";
import { LoomAgUiAgent } from "../src/main/ag-ui-agent.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

async function fixture(run: (host: LibraryAgentHost, adapter: LoomAgUiAgent) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "loom-ag-ui-"));
	const server = createServer((_request, response) => {
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

test("CopilotKit clones keep the host and run lifecycle", { timeout: 10_000 }, async () => {
	await fixture(async (host, adapter) => {
		const session = await host.createSession();
		const events = await lastValueFrom(adapter.clone().run(input(session.id)).pipe(toArray()));
		assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
	});
});
