import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	createHttpRerankProvider,
	parseRerankResponse,
} from "../src/main/models/rerank-provider.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("createHttpRerankProvider posts query and documents", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			results: [
				{ index: 1, relevance_score: 0.9 },
				{ index: 0, relevance_score: 0.1 },
			],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpRerankProvider({
		requestUrl: "https://api.example.com/v2/custom-rerank/?region=cn",
		apiKey: "secret",
		model: "jina-reranker-v2-base-multilingual",
	});
	const scores = await provider.rerank("bike", ["soup", "bicycle"]);
	assert.deepEqual(scores, [0.1, 0.9]);
	assert.equal(calls[0]?.url, "https://api.example.com/v2/custom-rerank/?region=cn");
	const headers = new Headers(calls[0]?.init.headers);
	assert.equal(headers.get("authorization"), "Bearer secret");
	const body = JSON.parse(String(calls[0]?.init.body)) as {
		model: string;
		query: string;
		documents: string[];
		top_n: number;
	};
	assert.equal(body.model, "jina-reranker-v2-base-multilingual");
	assert.equal(body.query, "bike");
	assert.deepEqual(body.documents, ["soup", "bicycle"]);
	assert.equal(body.top_n, 2);
});

test("createHttpRerankProvider posts Bailian qwen3-rerank to /reranks", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			object: "list",
			results: [{ index: 0, relevance_score: 0.8 }],
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpRerankProvider({
		requestUrl: "https://dashscope.aliyuncs.com/compatible-api/v1/reranks",
		apiKey: "sk-test",
		model: "qwen3-rerank",
	});
	const scores = await provider.rerank("bike", ["soup"]);
	assert.deepEqual(scores, [0.8]);
	assert.equal(calls[0]?.url, "https://dashscope.aliyuncs.com/compatible-api/v1/reranks");
	const body = JSON.parse(String(calls[0]?.init.body)) as { query?: string; input?: unknown };
	assert.equal(body.query, "bike");
	assert.equal(body.input, undefined);
});

test("createHttpRerankProvider posts Bailian gte-rerank-v2 on the native path", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response(JSON.stringify({
			output: { results: [{ index: 0, relevance_score: 0.7 }] },
		}), { status: 200 });
	}) as typeof fetch;

	const provider = createHttpRerankProvider({
		requestUrl: "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank",
		apiKey: "sk-test",
		model: "gte-rerank-v2",
	});
	await provider.rerank("bike", ["soup"]);
	assert.equal(calls[0]?.url, "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank");
	const body = JSON.parse(String(calls[0]?.init.body)) as {
		input?: { query: string; documents: string[] };
	};
	assert.equal(body.input?.query, "bike");
	assert.deepEqual(body.input?.documents, ["soup"]);
});

test("parseRerankResponse reads Cohere, Jina, and DashScope shapes", () => {
	assert.deepEqual(
		parseRerankResponse(JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] }), 1),
		[0.5],
	);
	assert.deepEqual(
		parseRerankResponse(JSON.stringify({ data: [{ index: 0, score: 0.4 }] }), 1),
		[0.4],
	);
	assert.deepEqual(
		parseRerankResponse(JSON.stringify({ output: { results: [{ index: 0, relevance_score: 0.3 }] } }), 1),
		[0.3],
	);
});
