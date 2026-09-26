import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { modelsUrl, probeModelSlot, rerankUrl } from "../src/main/model-probe.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("modelsUrl and rerankUrl follow the OpenAI /vN leaf rule", () => {
	assert.equal(modelsUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1/models");
	assert.equal(modelsUrl("https://qianfan.baidubce.com/v2"), "https://qianfan.baidubce.com/v2/models");
	assert.equal(rerankUrl("https://api.example.com/v1"), "https://api.example.com/v1/rerank");
});

test("probeModelSlot succeeds on GET /v1/models", async () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url) => {
		calls.push(String(url));
		return new Response(JSON.stringify({ data: [{ id: "llama" }] }), { status: 200 });
	}) as typeof fetch;
	const result = await probeModelSlot({
		slot: "chat",
		baseUrl: "http://127.0.0.1:1234",
		model: "llama",
	});
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(calls, ["http://127.0.0.1:1234/v1/models"]);
});

test("probeModelSlot treats 401 as a hard failure", async () => {
	globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
	const result = await probeModelSlot({
		slot: "chat",
		baseUrl: "https://api.example.com",
		model: "gpt",
		apiKey: "bad",
	});
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /401/);
});

test("probeModelSlot keeps the full HTTP error body", async () => {
	const body = `{"error":"${"x".repeat(400)}"}`;
	globalThis.fetch = (async () => new Response(body, { status: 500 })) as typeof fetch;
	const result = await probeModelSlot({
		slot: "chat",
		baseUrl: "https://api.example.com",
		model: "gpt",
	});
	assert.equal(result.ok, false);
	assert.equal(result.error, `HTTP 500: ${body}`);
});

test("probeModelSlot falls back to the slot POST when /models is missing", async () => {
	const calls: Array<{ url: string; body: string | undefined }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined });
		if (String(url).endsWith("/models")) return new Response("", { status: 404 });
		return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 });
	}) as typeof fetch;
	const result = await probeModelSlot({
		slot: "embedding",
		baseUrl: "http://127.0.0.1:11434",
		model: "embed",
	});
	assert.deepEqual(result, { ok: true });
	assert.equal(calls[1]?.url, "http://127.0.0.1:11434/v1/embeddings");
	assert.equal(JSON.parse(calls[1]?.body ?? "{}").input[0], "ping");
});

test("probeModelSlot requires URL and model", async () => {
	const result = await probeModelSlot({ slot: "vlm", baseUrl: "", model: "" });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /required/i);
});

test("probeModelSlot POSTs rerank without treating GET /models as success", async () => {
	const calls: string[] = [];
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${String(url)}`);
		if (String(url).endsWith("/models")) {
			return new Response(JSON.stringify({ data: [{ id: "qwen3-rerank" }] }), { status: 200 });
		}
		return new Response(JSON.stringify({
			results: [{ index: 0, relevance_score: 0.1 }],
		}), { status: 200 });
	}) as typeof fetch;
	const result = await probeModelSlot({
		slot: "rerank",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		model: "qwen3-rerank",
		apiKey: "sk-test",
	});
	assert.deepEqual(result, { ok: true });
	assert.equal(calls.includes("GET https://dashscope.aliyuncs.com/compatible-mode/v1/models"), false);
	assert.equal(calls.some((call) => call.includes("/compatible-api/v1/reranks")), true);
});
