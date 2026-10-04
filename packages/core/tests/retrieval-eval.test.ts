import assert from "node:assert/strict";
import { test } from "node:test";
import { ndcgAtK, recallAtK } from "../evals/metrics.ts";
import { embeddingFromEnv, embeddingsUrl, parseEmbeddingResponse } from "../evals/http-embed.ts";
import { EVAL_FILES } from "../evals/library.ts";
import { RETRIEVAL_QRELS, retrievalKind } from "../evals/qrels.ts";
import { RETRIEVAL_K, runRetrievalEval } from "../evals/retrieval.ts";

test("embeddingFromEnv needs a base URL and model", () => {
	assert.equal(embeddingFromEnv({}), undefined);
	assert.equal(embeddingFromEnv({ LOOM_EMBED_BASE_URL: "http://127.0.0.1:8080/v1" }), undefined);
	assert.deepEqual(
		embeddingFromEnv({
			LOOM_EMBED_BASE_URL: "http://127.0.0.1:8080/v1",
			LOOM_EMBED_MODEL: "text-embedding",
			LOOM_EMBED_API_KEY: "secret",
		}),
		{ baseUrl: "http://127.0.0.1:8080/v1", model: "text-embedding", apiKey: "secret" },
	);
});

test("embeddingsUrl appends /v1/embeddings", () => {
	assert.equal(embeddingsUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1/embeddings");
	assert.equal(embeddingsUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1/embeddings");
	assert.equal(embeddingsUrl("http://127.0.0.1:8080/v1/embeddings"), "http://127.0.0.1:8080/v1/embeddings");
});

test("parseEmbeddingResponse sorts by index", () => {
	assert.deepEqual(
		parseEmbeddingResponse(
			JSON.stringify({
				data: [
					{ index: 1, embedding: [0, 1] },
					{ index: 0, embedding: [1, 0] },
				],
			}),
			2,
		),
		[[1, 0], [0, 1]],
	);
});

test("recallAtK and ndcgAtK score binary gold paths", () => {
	assert.equal(recallAtK(["a", "b", "c"], ["a"], 3), 1);
	assert.equal(recallAtK(["b", "c"], ["a"], 3), 0);
	assert.equal(recallAtK(["b", "a"], ["a"], 1), 0);
	assert.equal(recallAtK(["b", "a"], ["a"], 2), 1);
	assert.equal(ndcgAtK(["a"], ["a"], 3), 1);
	assert.ok(ndcgAtK(["b", "a"], ["a"], 2) < 1);
	assert.equal(ndcgAtK(["b", "c"], ["a"], 2), 0);
});

test("retrieval gold set ranks intended assets at k=3", async () => {
	const result = await runRetrievalEval();
	assert.equal(result.k, RETRIEVAL_K);
	assert.equal(result.provider, "eval-embed");
	assert.equal(result.cases.length > 0, true);
	assert.equal(result.meanRecall, 1);
	assert.equal(result.meanRecallByKind.fts, 1);
	assert.equal(result.meanRecallByKind.semantic, 1);
	assert.equal(result.meanRecallByKind.property, 1);
	assert.ok(result.meanNdcg >= 0.9);
	for (const row of result.cases) {
		assert.equal(row.recall, 1, row.id);
	}
});

const STOP = new Set([
	"this", "that", "with", "from", "have", "been", "they", "them", "your", "about",
	"into", "over", "under", "than", "then", "when", "what", "which", "while",
	"would", "could", "should", "how", "for", "the", "and", "are", "was",
]);

function contentWords(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/i)
			.filter((word) => word.length >= 4 && !STOP.has(word)),
	);
}

test("semantic queries do not share content words with gold files", () => {
	const byPath = new Map(EVAL_FILES.map((file) => [file.relativePath, file.text]));
	for (const qrel of RETRIEVAL_QRELS) {
		if (retrievalKind(qrel.id) !== "semantic") continue;
		const queryWords = contentWords(qrel.query);
		for (const path of qrel.relevant) {
			const text = byPath.get(path);
			assert.ok(text, path);
			const overlap = [...queryWords].filter((word) => contentWords(text).has(word));
			assert.deepEqual(overlap, [], `${qrel.id} vs ${path}`);
		}
	}
});
