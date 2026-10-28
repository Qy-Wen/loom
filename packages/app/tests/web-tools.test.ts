import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWebTools, fetchUrl } from "../src/main/tools/web-tools.ts";
import { deepSeekWebProvider } from "../src/main/web/deepseek.ts";
import type { WebProvider } from "../src/main/web/types.ts";
import { WebToolsService } from "../src/main/web/web-service.ts";

function deepseek(respond: (url: string, body: any) => Response, key: string | null = "sk-test") {
	const calls: { url: string; auth: string | null; body: any }[] = [];
	const tools = createWebTools(deepSeekWebProvider, async () => key ?? undefined, (async (url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		calls.push({ url, auth: new Headers(init.headers).get("authorization"), body });
		return respond(url, body);
	}) as typeof fetch);
	return { calls, search: tools[0]!, fetch: tools[1]! };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("web tools with the DeepSeek provider", () => {
	it("searches with the Bearer key, no page bodies, and gives the model the summaries", async () => {
		const { calls, search } = deepseek(() => json({ results: [{ title: "DeepSeek V4", url: "https://a.example/v4", summary: "Released.", snippet: "short", site_name: "A", date: "2026-06-01T00:00:00+00:00" }] }));
		const out = String(await search.execute({ query: " deepseek v4 " }));
		assert.deepEqual(calls[0], { url: "https://api.deepseek.com/v1/tools/search", auth: "Bearer sk-test", body: { query: "deepseek v4", count: 8, need_content: false } });
		assert.match(out, /1\. DeepSeek V4\n\s+https:\/\/a\.example\/v4\nA · 2026-06-01\nReleased\./);
		assert.match(search.description, /DeepSeek/);
		assert.match(search.description, /site:/);
	});

	it("rejects bad search arguments before any request", async () => {
		const { calls, search } = deepseek(() => json({}));
		await assert.rejects(() => Promise.resolve(search.execute({ query: "  " })), /query/);
		await assert.rejects(() => Promise.resolve(search.execute({ query: "x".repeat(129) })), /128/);
		await assert.rejects(() => Promise.resolve(search.execute({ query: "a", count: 51 })), /count/);
		assert.equal(calls.length, 0);
	});

	it("says so when nothing matches", async () => {
		const { search } = deepseek(() => json({ results: [] }));
		assert.match(String(await search.execute({ query: "zzzz" })), /No results/);
	});

	it("fetches a page as titled text and refuses unusable URLs", async () => {
		const { calls, fetch } = deepseek(() => json({ title: "Post", content: "Body text" }));
		assert.equal(await fetch.execute({ url: "https://a.example/post" }), "# Post\n\nBody text");
		assert.deepEqual(calls[0]!.body, { url: "https://a.example/post" });
		for (const url of ["ftp://a.example/x", "https://user:pw@a.example/", "not a url", "file:///etc/passwd"]) {
			await assert.rejects(() => Promise.resolve(fetch.execute({ url })), /url/);
		}
		assert.equal(calls.length, 1);
		assert.equal(fetchUrl("HTTPS://A.example/x y"), "https://a.example/x%20y");
	});

	it("turns HTTP failures into advice the model can act on", async () => {
		for (const [status, pattern] of [[401, /key.*invalid/i], [402, /balance/i], [404, /Do not retry/], [429, /Rate limit/], [503, /error/i]] as const) {
			const { fetch } = deepseek(() => json({ error: { message: "nope" } }, status));
			await assert.rejects(() => Promise.resolve(fetch.execute({ url: "https://a.example/" })), (error: Error) => {
				assert.match(error.message, new RegExp(`HTTP ${status}`));
				assert.match(error.message, pattern);
				assert.doesNotMatch(error.message, /sk-test/);
				return true;
			});
		}
	});

	it("explains a missing key and an empty page", async () => {
		const none = deepseek(() => json({}), null);
		await assert.rejects(() => Promise.resolve(none.search.execute({ query: "a" })), /No DeepSeek API key/);
		const empty = deepseek(() => json({ title: "T", content: "  " }));
		await assert.rejects(() => Promise.resolve(empty.fetch.execute({ url: "https://a.example/" })), /no readable text/);
	});
});

describe("web provider seam", () => {
	const searchOnly: WebProvider = {
		id: "acme", name: "Acme", chatProviderId: "acme-chat", limits: { query: 50, count: 5 },
		search: async ({ query, count }) => [{ title: `${query}/${count}`, url: "https://acme.example/1", summary: "s" }],
	};

	it("offers web_fetch only when the vendor can fetch, and uses that vendor's limits", async () => {
		const tools = createWebTools(searchOnly, async () => "k");
		assert.deepEqual(tools.map((tool) => tool.name), ["web_search"]);
		assert.doesNotMatch(tools[0]!.description, /web_fetch/);
		assert.match(String(await tools[0]!.execute({ query: "q", count: 5 })), /q\/5/);
		await assert.rejects(() => Promise.resolve(tools[0]!.execute({ query: "q", count: 6 })), /1 to 5/);
		assert.deepEqual(createWebTools(deepSeekWebProvider, async () => "k").map((tool) => tool.name), ["web_search", "web_fetch"]);
	});

	function service(keys: Record<string, string | undefined>, enabled = { value: true }) {
		return new WebToolsService({ enabled: async () => enabled.value, apiKey: async (id) => keys[id] }, [searchOnly, deepSeekWebProvider]);
	}

	it("picks the first vendor whose Chat provider has a key, and none without one or when switched off", async () => {
		const enabled = { value: true };
		const keys: Record<string, string | undefined> = {};
		const web = service(keys, enabled);
		assert.deepEqual(await web.tools(), []);
		assert.equal(await web.changed(), false);

		keys.deepseek = "sk";
		assert.equal(await web.changed(), true);
		assert.deepEqual((await web.tools()).map((tool) => tool.name), ["web_search", "web_fetch"]);
		assert.equal(await web.changed(), false);

		keys["acme-chat"] = "ak";
		assert.equal(await web.changed(), true, "an earlier vendor in the list takes over");
		assert.deepEqual((await web.tools()).map((tool) => tool.name), ["web_search"]);

		enabled.value = false;
		assert.equal(await web.changed(), true);
		assert.deepEqual(await web.tools(), []);
		assert.equal(await web.changed(), false);
	});

	it("keeps tool objects stable across calls so a re-sync without a real change is a no-op", async () => {
		const web = service({ deepseek: "sk" });
		assert.equal((await web.tools())[0], (await web.tools())[0]);
	});
});
