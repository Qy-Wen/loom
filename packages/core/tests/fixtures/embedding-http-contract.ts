import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EmbeddingProvider } from "../../src/model/text-embed.ts";

// Run identical wire fixtures through the production and evaluation entry points.
export function embeddingHttpContract(
	name: string,
	create: (slot: { model: string; apiKey: string }) => EmbeddingProvider,
	expectedUrl: string,
): void {
	describe(name, () => {
		test("posts inputs, sorts indexed vectors, and forwards cancellation", async (t) => {
			const signal = new AbortController().signal;
			const request = t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
				assert.equal(String(url), expectedUrl);
				assert.equal(init?.method, "POST");
				assert.equal(init?.signal, signal);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("content-type"), "application/json");
				assert.equal(headers.get("authorization"), "Bearer secret");
				assert.deepEqual(JSON.parse(String(init?.body)), { model: "embed-model", input: ["a", "b"] });
				return Response.json({ data: [
					{ index: 1, embedding: [0.2, 0.4] },
					{ index: 0, embedding: [0.1, 0.3] },
				] });
			});
			const provider = create({ model: " embed-model ", apiKey: " secret " });
			assert.equal(provider.modelId, "embed-model");
			assert.deepEqual(await provider.embed(["a", "b"], signal), [[0.1, 0.3], [0.2, 0.4]]);
			assert.equal(request.mock.callCount(), 1);
		});

		test("decodes base64 float32 vectors and omits empty authorization", async (t) => {
			// Fixed little-endian bytes for [1, 2], independent of host typed-array layout.
			t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
				assert.equal(new Headers(init?.headers).has("authorization"), false);
				return Response.json({ data: [{ embedding: "AACAPwAAAEA=" }] });
			});
			assert.deepEqual(await create({ model: "embed-model", apiKey: " " }).embed(["a"]), [[1, 2]]);
		});

		test("skips HTTP for empty input", async (t) => {
			const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected HTTP"); });
			assert.deepEqual(await create({ model: "embed-model", apiKey: "" }).embed([]), []);
			assert.equal(request.mock.callCount(), 0);
		});

		test("rejects an empty model", () => {
			assert.throws(() => create({ model: " ", apiKey: "" }), /Embedding model is required/);
		});

		test("propagates fetch aborts", async (t) => {
			const controller = new AbortController();
			const reason = new Error("cancelled");
			controller.abort(reason);
			t.mock.method(globalThis, "fetch", async (...[_url, init]: Parameters<typeof fetch>) => {
				assert.equal(init?.signal, controller.signal);
				init?.signal?.throwIfAborted();
				throw new Error("Expected aborted signal");
			});
			await assert.rejects(create({ model: "embed-model", apiKey: "" }).embed(["a"], controller.signal),
				(error) => error === reason);
		});

		test("reports status and a bounded HTTP error body", async (t) => {
			const body = "x".repeat(300);
			t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 429 }));
			await assert.rejects(create({ model: "embed-model", apiKey: "" }).embed(["a"]), {
				message: `Embedding request failed (429): ${body.slice(0, 240)}`,
			});
		});

		const invalidResponses = [
			{ body: "not json", error: "Embedding response is not JSON" },
			{ body: "null", error: "Embedding response is missing data" },
			{ body: '{"data":{}}', error: "Embedding response is missing data" },
			{ body: '{"data":[]}', error: "Embedding provider returned the wrong number of vectors" },
			{ body: '{"data":[{}]}', error: "Embedding response item 0 is missing embedding" },
			{ body: '{"data":[{"embedding":[1,"bad"]}]}', error: "Embedding response item 0 has an unsupported vector" },
		];
		for (const fixture of invalidResponses) {
			test(`rejects ${fixture.body}`, async (t) => {
				t.mock.method(globalThis, "fetch", async () => new Response(fixture.body));
				await assert.rejects(create({ model: "embed-model", apiKey: "" }).embed(["a"]), {
					message: fixture.error,
				});
			});
		}
	});
}
