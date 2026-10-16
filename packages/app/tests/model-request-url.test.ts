import assert from "node:assert/strict";
import { test } from "node:test";
import { modelRequestUrl } from "../src/shared/model-request-url.ts";

test("request URLs retain exact paths, versions, trailing slashes and queries", () => {
	for (const url of [
		"https://example.com/v1/embeddings", "https://example.com/v2/rerank",
		"https://proxy.example.com/inference/?region=cn", "http://localhost:1234/v1/chat/completions",
		"https://dashscope.aliyuncs.com/compatible-api/v1/reranks",
	]) assert.equal(modelRequestUrl(`  ${url}  `), url);
	assert.equal(modelRequestUrl("https://example.com/v2"), "https://example.com/v2");
});

test("request URLs reject missing, invalid, non-HTTP and embedded-secret addresses", () => {
	for (const url of ["", "example.com", "file:///tmp/model", "https://user:secret@example.com/api", "https://example.com/api#fragment"]) {
		assert.throws(() => modelRequestUrl(url), /Request URL/);
	}
});
