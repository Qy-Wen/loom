import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddingHttpContract } from "../../core/tests/fixtures/embedding-http-contract.ts";
import { createHttpEmbeddingProvider } from "../src/main/models/embedding-provider.ts";

const requestUrl = "https://api.example.com/custom-embed/?version=2";
embeddingHttpContract("production Embedding HTTP contract", (slot) =>
	createHttpEmbeddingProvider({ ...slot, requestUrl }), requestUrl);

test("production preserves complete request URLs", async (t) => {
	for (const url of [requestUrl, "https://api.example.com/v2/embeddings", "http://localhost:8080/custom/"]) {
		t.mock.method(globalThis, "fetch", async (...[actual]: Parameters<typeof fetch>) => {
			assert.equal(String(actual), url);
			return Response.json({ data: [{ embedding: [1, 2] }] });
		});
		await createHttpEmbeddingProvider({ requestUrl: ` ${url} `, model: "embed", apiKey: "" }).embed(["a"]);
		t.mock.restoreAll();
	}
});

test("production validates request URLs before making requests", () => {
	for (const url of ["", "example.com", "file:///tmp/embed", "https://user:pass@example.com/embed", "https://example.com/embed#x"]) {
		assert.throws(() => createHttpEmbeddingProvider({ requestUrl: url, model: "embed", apiKey: "" }), /Request URL/);
	}
});
