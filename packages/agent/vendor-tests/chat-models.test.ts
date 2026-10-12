import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AssistantEntry,
	buildChatModels,
	chatEndpointReady,
	createRegistry,
	DEFAULT_CHAT_CONTEXT_WINDOW,
	Harness,
	openNodeSqliteStorage,
	ProviderDoc,
	watchEvents,
	type AgentEvent,
} from "@loom/agent/durable";

test("buildChatModels preserves Loom endpoint configuration and auth", async () => {
	assert.equal(chatEndpointReady(undefined), false);
	assert.equal(chatEndpointReady({ baseUrl: " ", model: "demo" }), false);
	assert.equal(chatEndpointReady({ baseUrl: "https://example.com", model: " " }), false);
	assert.throws(() => buildChatModels({ baseUrl: " ", model: "demo" }), /Chat is not configured/);
	const { models, model } = buildChatModels({ baseUrl: " https://example.com/v1/// ", model: " demo ", apiKey: " test-key ", contextWindow: 200_000 });
	assert.equal(model.baseUrl, "https://example.com/v1");
	assert.equal(model.id, "demo");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 8192);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.compat, { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" });
	assert.deepEqual(await models.getAuth(model), { auth: { apiKey: "test-key" }, source: "settings" });
	assert.equal(buildChatModels({ baseUrl: "https://example.com", model: "demo" }).model.contextWindow, DEFAULT_CHAT_CONTEXT_WINDOW);
});

test("Loom Chat uses OpenAI SSE on SQLite, restores context, and deduplicates after reopen", { timeout: 15_000 }, async () => {
	type Request = { model: string; messages: Array<{ role: string; content: unknown }>; max_tokens?: number; stream?: boolean; store?: boolean };
	const requests: Request[] = [];
	const authorizations: Array<string | undefined> = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.url, "/v1/chat/completions");
			assert.equal(request.method, "POST");
			let body = "";
			for await (const chunk of request) body += chunk;
			requests.push(JSON.parse(body) as Request);
			authorizations.push(request.headers.authorization);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const frame = (delta: object, finish_reason: string | null, usage?: object) =>
				`data: ${JSON.stringify({ id: `reply-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "demo", choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
			response.write(frame({ role: "assistant", content: requests.length === 1 ? "hello" : "welcome back" }, null));
			response.write(frame({}, "stop", { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }));
			response.end("data: [DONE]\n\n");
		} catch (error) {
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: String(error) } }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const directory = await mkdtemp(join(tmpdir(), "loom-chat-sqlite-"));
	const file = join(directory, "session.sqlite");
	const endpoint = { baseUrl: ` http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/ `, model: " demo ", apiKey: " test-key " };
	let harness: Harness | undefined;
	try {
		const { models, model } = buildChatModels(endpoint);
		harness = await Harness.open(await openNodeSqliteStorage(file), { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } });
		const stream = await watchEvents(harness, root.id, BACKGROUND_CONTEXT);
		const received: AgentEvent[] = [];
		const ended = Promise.withResolvers<void>();
		stream.start(async (events) => { received.push(...events); if (events.some((event) => event.type === "run_end")) ended.resolve(); });
		const draft = { type: "input", content: "hi", requestId: "greeting-1" } as const;
		const submission = await root.submit(draft, BACKGROUND_CONTEXT);
		try {
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");
			await ended.promise;
		} finally {
			await stream.stop();
		}
		assert.ok(received.some((event) => event.type === "message_end" && AssistantEntry.is(event.entry)));
		assert.ok(received.some((event) => event.type === "usage_changed"));
		const entries = (await root.entries({ order: "ascending" }, 20, undefined, BACKGROUND_CONTEXT)).items;
		assert.deepEqual(entries.map((entry) => entry.kind), ["pi.user", "pi.assistant"]);
		assert.deepEqual(entries.at(-1)?.model?.[0]?.content, [{ type: "text", text: "hello" }]);
		const provider = await harness.snapshot(ProviderDoc, root.id, BACKGROUND_CONTEXT);
		assert.ok(provider?.sessionId);
		const rootId = root.id;
		await harness.close(BACKGROUND_CONTEXT);
		harness = undefined;

		// Rebuild the model catalog as a fresh process would; SQLite supplies conversation state.
		const next = buildChatModels(endpoint);
		harness = await Harness.open(await openNodeSqliteStorage(file), { models: next.models, registry: createRegistry() }, BACKGROUND_CONTEXT);
		const reopened = await harness.root(BACKGROUND_CONTEXT);
		assert.equal(reopened.id, rootId);
		assert.deepEqual(await harness.snapshot(ProviderDoc, reopened.id, BACKGROUND_CONTEXT), provider);
		assert.equal((await reopened.submit(draft, BACKGROUND_CONTEXT)).id, submission.id);
		assert.equal(requests.length, 1);
		assert.equal((await (await reopened.submit({ type: "input", content: "again" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
		assert.equal(requests.length, 2);
		assert.deepEqual(authorizations, ["Bearer test-key", "Bearer test-key"]);
		assert.deepEqual(requests[1]?.messages.map(({ role }) => role), ["user", "assistant", "user"]);
		assert.equal(requests[1]?.messages[1]?.content, "hello");
		for (const request of requests) {
			assert.equal(request.model, "demo");
			assert.equal(request.stream, true);
			assert.equal(request.max_tokens, 8192);
			assert.equal(request.store, undefined);
		}
	} finally {
		await harness?.close(BACKGROUND_CONTEXT);
		await rm(directory, { recursive: true, force: true });
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});
