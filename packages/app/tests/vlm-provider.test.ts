import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	createHttpVlmProvider,
	parseVlmResponse,
	vlmChatUrl,
	vlmRequestBody,
} from "../src/main/vlm-provider.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("vlmChatUrl appends /v1/chat/completions", () => {
	assert.equal(vlmChatUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1/chat/completions");
	assert.equal(vlmChatUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/chat/completions");
	assert.equal(vlmChatUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
	assert.equal(vlmChatUrl("http://127.0.0.1:11434"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("createHttpVlmProvider posts OpenAI chat/completions with image_url", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			choices: [{ message: { content: "## Caption\nGreen.\n" } }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpVlmProvider({
		baseUrl: "http://127.0.0.1:1234",
		apiKey: "",
		model: "qwen/qwen3-vl-4b",
	});
	const text = await provider.describe({ filename: "shot.jpg", bytes: new Uint8Array([9]) });
	assert.match(text, /Green/);
	assert.equal(calls[0]?.url, "http://127.0.0.1:1234/v1/chat/completions");
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get("authorization"), null);
	const body = JSON.parse(String(calls[0]?.init.body)) as {
		model: string;
		messages: Array<{ role: string; content: unknown }>;
	};
	assert.equal(body.model, "qwen/qwen3-vl-4b");
	assert.equal(body.messages[0]?.role, "system");
	const content = body.messages[1]?.content as Array<{ type: string; image_url?: { url: string } }>;
	assert.equal(content.some((part) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/jpeg;base64,")), true);
});

test("createHttpVlmProvider sends a Bearer key for remote APIs", async () => {
	globalThis.fetch = (async (_url, init) => {
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer secret");
		return new Response(JSON.stringify({
			choices: [{ message: { content: "ok" } }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpVlmProvider({
		baseUrl: "https://api.example.com/v1",
		apiKey: "secret",
		model: "gpt-4o-mini",
	});
	assert.equal(await provider.describe({ filename: "shot.png", bytes: new Uint8Array([1]) }), "ok");
});

test("parseVlmResponse reads OpenAI choices", () => {
	assert.equal(
		parseVlmResponse(JSON.stringify({ choices: [{ message: { content: "Hello" } }] })),
		"Hello",
	);
	assert.equal(
		parseVlmResponse(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "Hi" }] } }] })),
		"Hi",
	);
});

test("vlmRequestBody uses chat completions image_url parts", () => {
	const body = vlmRequestBody("gpt-4o", "data:image/png;base64,xx");
	assert.ok(Array.isArray(body.messages));
});
