import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	createHttpEmbeddingProvider,
	parseEmbeddingResponse,
} from "../src/main/embedding-provider.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("createHttpEmbeddingProvider posts OpenAI-compatible embeddings", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			data: [
				{ index: 1, embedding: [0.2, 0.4] },
				{ index: 0, embedding: [0.1, 0.3] },
			],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpEmbeddingProvider({
		baseUrl: "https://api.example.com/custom-embed/?version=2",
		apiKey: "secret",
		model: "text-embedding-3-small",
	});
	const vectors = await provider.embed(["a", "b"]);
	assert.deepEqual(vectors, [[0.1, 0.3], [0.2, 0.4]]);
	assert.equal(calls[0]?.url, "https://api.example.com/custom-embed/?version=2");
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get("authorization"), "Bearer secret");
	assert.equal(JSON.parse(String(calls[0]?.init.body)).model, "text-embedding-3-small");
});

test("parseEmbeddingResponse accepts base64 vectors", () => {
	const bytes = Buffer.from(new Float32Array([1, 2]).buffer).toString("base64");
	const vectors = parseEmbeddingResponse(JSON.stringify({ data: [{ embedding: bytes }] }), 1);
	assert.equal(vectors[0]?.length, 2);
	assert.ok(Math.abs(vectors[0]![0]! - 1) < 1e-6);
});
