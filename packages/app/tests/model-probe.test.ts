import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { probeModelSlot } from "../src/main/models/model-probe.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

for (const slot of ["vlm", "audio", "embedding", "rerank"] as const) {
	test(`probe ${slot} POSTs only to the exact configured URL`, async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		globalThis.fetch = (async (url, init) => {
			calls.push({ url: String(url), init: init ?? {} });
			return new Response(JSON.stringify(slot === "embedding" ? { data: [{ embedding: [0.1] }] }
				: slot === "rerank" ? { results: [{ index: 0, relevance_score: 0.8 }] }
					: { choices: [{ message: { content: "pong" } }] }));
		}) as typeof fetch;
		const url = "https://proxy.example.com/custom/inference/?region=cn";
		assert.deepEqual(await probeModelSlot({ slot, requestUrl: url, model: "test", apiKey: "test-key" }), { ok: true });
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, url);
		assert.equal(calls[0]?.init.method, "POST");
		assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer test-key");
		const body = JSON.parse(String(calls[0]?.init.body));
		assert.equal(body.model, "test");
		if (slot === "embedding") assert.deepEqual(body.input, ["ping"]);
		else if (slot === "rerank") assert.equal(body.query, "ping");
		else assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
		assert.ok(calls[0]?.init.signal);
	});
}

test("probeModelSlot treats 401 as a hard failure", async () => {
	globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
	const result = await probeModelSlot({ slot: "vlm", requestUrl: "https://api.example.com/chat", model: "gpt", apiKey: "bad" });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /401/);
});

test("probeModelSlot keeps the full HTTP error body", async () => {
	const body = `{"error":"${"x".repeat(400)}"}`;
	globalThis.fetch = (async () => new Response(body, { status: 500 })) as typeof fetch;
	const result = await probeModelSlot({ slot: "vlm", requestUrl: "https://api.example.com/chat", model: "gpt" });
	assert.equal(result.error, `HTTP 500: ${body}`);
});

test("probeModelSlot does not try alternative routes on 404", async () => {
	let calls = 0;
	globalThis.fetch = (async () => { calls++; return new Response("missing", { status: 404 }); }) as typeof fetch;
	assert.equal((await probeModelSlot({ slot: "embedding", requestUrl: "https://api.example.com/embed", model: "m" })).ok, false);
	assert.equal(calls, 1);
});

test("probeModelSlot requires an HTTP(S) URL and model before making requests", async () => {
	globalThis.fetch = (async () => { throw new Error("should not fetch"); }) as typeof fetch;
	for (const requestUrl of ["", "invalid", "file:///tmp/model"]) {
		assert.match((await probeModelSlot({ slot: "vlm", requestUrl, model: "m" })).error ?? "", /Request URL/);
	}
	assert.match((await probeModelSlot({ slot: "vlm", requestUrl: "https://example.com/chat", model: "" })).error ?? "", /Model is required/);
});
