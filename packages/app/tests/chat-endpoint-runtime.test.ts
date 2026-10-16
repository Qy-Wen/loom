import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createChatCustomProvider } from "@loom/agent/chat-runtime";
import { buildCustomProvider, customProviderDraft } from "../src/renderer/settings/chat-custom-draft.ts";

const sse = (events: Array<Record<string, unknown>>) => events.map((event) =>
	`${typeof event.type === "string" ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
).join("");

for (const [api, path, events] of [
	["openai-completions", "/proxy/v2/chat/completions", [
		{ id: "test", object: "chat.completion.chunk", model: "demo", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
	]],
	["openai-responses", "/proxy/v2/responses", [
		{ type: "response.completed", response: { id: "test", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } },
	]],
	["anthropic-messages", "/proxy/v1/messages?beta=true", [
		{ type: "message_start", message: { id: "test", type: "message", role: "assistant", model: "demo", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]],
	["google-generative-ai", "/proxy/v1beta/models/demo:streamGenerateContent?alt=sse", [
		{ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } },
	]],
] as const) test(`full URL inference reaches the native ${api} SDK path without duplicating it`, { timeout: 15_000 }, async () => {
	const requests: string[] = [];
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) { /* Drain the native request body. */ }
		requests.push(`${request.method} ${request.url}`);
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(sse([...events]));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const draft = customProviderDraft();
		draft.requestUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
		draft.models[0]!.id = "demo";
		const config = buildCustomProvider("custom-test", draft);
		assert.equal(config.api, api);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(config.id, async () => ({ type: "api_key", key: "test-key" }));
		const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(createChatCustomProvider(config));
		const model = models.getModel(config.id, "demo")!;
		const output = await models.completeSimple(model, { messages: [{ role: "user", content: "ping", timestamp: 1 }] }, { maxRetries: 0, signal: AbortSignal.timeout(10_000) });
		assert.notEqual(output.stopReason, "error", output.errorMessage);
		assert.deepEqual(requests, [`POST ${path}`]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
