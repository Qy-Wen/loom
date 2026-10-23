import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Type, InMemoryCredentialStore, type Credential, type Model, type Provider, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, createProvider, getSupportedThinkingLevels, isModelType } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { overlayChatProvider, withGenerationDefaults } from "./fixtures/chat-provider-prototype.ts";

const noEnv = { env: async () => undefined, fileExists: async () => false };
const catalog = builtinProviders();
const native = (id: string): Provider => {
	const provider = catalog.find((provider) => provider.id === id);
	assert.ok(provider, id);
	return provider;
};
const oauth: Credential = { type: "oauth", access: "p0-fake-access", refresh: "p0-fake-refresh", expires: Date.now() + 3_600_000 };

// These are version-pinned probes, not promises about all future pi-ai versions.
test("P0: installed pi-ai 1.4.0 catalog has native protocols, nine OAuth providers, and only Radius refresh", () => {
	const aiPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-ai")), "utf8")) as { version: string };
	assert.equal(aiPackage.version, "1.4.0");
	assert.equal(catalog.length, 42);
	assert.equal(catalog.filter((provider) => provider.getModels().length > 0).length, 41);
	assert.deepEqual(catalog.filter((provider) => provider.auth.oauth).map((provider) => provider.id).sort(), [
		"anthropic", "github-copilot", "kimi-coding", "meta", "openai", "openai-codex", "openrouter", "radius", "xai",
	]);
	assert.deepEqual(catalog.filter((provider) => provider.refreshModels).map((provider) => provider.id), ["radius"]);
	for (const [id, api] of [["openai", "openai-responses"], ["anthropic", "anthropic-messages"], ["google", "google-generative-ai"], ["deepseek", "openai-completions"]]) {
		assert.ok(native(id).getModels().every((model) => model.api === api), id);
	}
	assert.deepEqual([...new Set(native("github-copilot").getModels().map((model) => model.api))].sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
});

test("P0: thin overlay preserves native auth/filtering and untouched capability metadata", async () => {
	const provider = native("github-copilot");
	const original = provider.getModels()[0]!;
	const wrapped = overlayChatProvider(provider, { baseUrl: "https://proxy.invalid/v1", contextWindow: 32000, headers: { "X-Loom-Probe": "yes" } });
	assert.equal(wrapped.auth, provider.auth);
	assert.ok(wrapped.filterModels);
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(provider.id, async () => ({ ...oauth, availableModelIds: [original.id] }));
	const models = createModels({ credentials, authContext: noEnv }); models.setProvider(wrapped);
	const available = await models.getAvailable(provider.id);
	assert.equal(available.length, 1);
	const model = available[0]!;
	assert.equal(model.id, original.id);
	assert.equal(model.api, original.api);
	assert.equal(model.contextWindow, 32000);
	assert.equal(model.baseUrl, "https://proxy.invalid/v1");
	assert.deepEqual(model.input, original.input);
	assert.deepEqual(model.cost, original.cost);
	assert.deepEqual(model.compat, original.compat);
	assert.deepEqual(getSupportedThinkingLevels(model), getSupportedThinkingLevels(original));
	assert.equal(original.contextWindow, provider.getModels()[0]!.contextWindow);
	assert.notEqual(original.baseUrl, model.baseUrl);
	// OAuth-derived endpoints have priority over static model endpoints (e.g. Copilot accounts).
	const auth = await models.getAuth(model);
	assert.equal(auth?.source, "OAuth");
	assert.equal(auth?.auth.headers?.["X-Loom-Probe"], "yes");
	assert.ok(auth?.auth.baseUrl?.includes("githubcopilot.com"));
});

test("P0: OpenAI OAuth chat filtering survives overlay without altering other operation catalogs", async () => {
	const provider = native("openai");
	const wrapped = overlayChatProvider(provider, { contextWindow: 32000 });
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => oauth);
	const models = createModels({ credentials, authContext: noEnv }); models.setProvider(wrapped);
	assert.ok(models.getModelsOfType("classifier", "openai").length > 0);
	assert.equal((await models.getAvailableOfType("classifier", "openai")).length, 0);
	assert.ok((await models.getAvailable("openai")).length > 0);
	const originalClassifier = provider.getAllModels!().find((model) => isModelType(model, "classifier"))!;
	assert.equal(models.getModelOfType("classifier", "openai", originalClassifier.id), originalClassifier);
});

test("P0: dynamic Provider publication remains visible through overlay and cache restore", async () => {
	const faux = fauxProvider();
	let calls = 0;
	const provider = createProvider({
		id: faux.provider.id, auth: faux.provider.auth, models: faux.models, api: faux.provider,
		fetchModels: async ({ signal }) => { signal.throwIfAborted(); calls++; return [{ ...faux.models[0], id: "dynamic", contextWindow: 64000 }]; },
	});
	const cache = new Map<string, { models: Model<string>[]; checkedAt: number }>();
	const modelsStore = { read: async (id: string) => cache.get(id), write: async (id: string, value: { models: Model<string>[]; checkedAt: number }) => { cache.set(id, value); }, delete: async (id: string) => { cache.delete(id); } };
	const models = createModels({ modelsStore, authContext: noEnv });
	models.setProvider(overlayChatProvider(provider, { contextWindow: 12345 }));
	assert.equal((await models.refresh({ signal: AbortSignal.timeout(2000) })).errors.size, 0);
	assert.equal(calls, 1);
	assert.equal(models.getModel(provider.id, "dynamic")?.contextWindow, 12345);
	assert.equal(cache.get(provider.id)?.models[0]?.contextWindow, 64000, "runtime overrides do not contaminate the native cache");
	const reopened = createModels({ modelsStore, authContext: noEnv });
	reopened.setProvider(overlayChatProvider(createProvider({ id: provider.id, auth: provider.auth, models: [], api: faux.provider, fetchModels: async () => { throw new Error("Offline restore must not fetch"); } }), { contextWindow: 12345 }));
	assert.equal((await reopened.refresh({ allowNetwork: false })).errors.size, 0);
	assert.equal(reopened.getModel(provider.id, "dynamic")?.contextWindow, 12345);
});

test("P0: native mixed-API dispatch builds real payloads without making network calls", { timeout: 15_000 }, async () => {
	const providers = [native("openai"), native("anthropic"), native("google"), native("deepseek"), native("github-copilot")];
	for (const provider of providers) {
		const models = createModels({ authContext: noEnv }); models.setProvider(overlayChatProvider(provider, { baseUrl: "https://proxy.invalid/v1" }));
		for (const api of new Set(provider.getModels().map((model) => model.api))) {
			const model = models.getModels(provider.id).find((model) => model.api === api)!;
			let payload: Record<string, unknown> | undefined;
			const result = await models.completeSimple(model, {
				messages: [{ role: "user", content: "ping", timestamp: 1 }],
				tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
			}, { apiKey: "p0-fake-key", maxTokens: 64, maxRetries: 0, signal: AbortSignal.timeout(2000),
				onPayload: (value) => { payload = value as Record<string, unknown>; throw new Error("P0_PAYLOAD_CAPTURED_NO_NETWORK"); },
			});
			assert.equal(result.stopReason, "error", `${provider.id}/${api}`);
			assert.match(result.errorMessage ?? "", /P0_PAYLOAD_CAPTURED_NO_NETWORK/);
			assert.ok(payload, `${provider.id}/${api}`);
			if (api === "openai-responses") { assert.ok(Array.isArray(payload.input)); assert.ok(Array.isArray(payload.tools)); }
			else if (api === "google-generative-ai") { assert.ok(Array.isArray(payload.contents)); assert.ok((payload.config as Record<string, unknown>).tools); }
			else { assert.ok(Array.isArray(payload.messages)); assert.ok(Array.isArray(payload.tools)); }
		}
	}
});

test("P0: generation defaults apply to streams but explicit compaction-style caps win", async () => {
	const faux = fauxProvider();
	const seen: { maxTokens?: number; temperature?: number }[] = [];
	const capture = (_context: TranscriptContext, options: { maxTokens?: number; temperature?: number } | undefined) => { seen.push({ maxTokens: options?.maxTokens, temperature: options?.temperature }); return answer("done"); };
	faux.setResponses([capture, capture, capture]);
	const models = createModels({ authContext: noEnv }); models.setProvider(withGenerationDefaults(faux.provider, { maxTokens: 4096, temperature: 0.4 }));
	await models.completeSimple(faux.models[0], { messages: [] });
	await models.completeSimple(faux.models[0], { messages: [] }, { maxTokens: 800, temperature: 0 });
	await models.completeSimple(faux.models[0], { messages: [] }, { maxTokens: undefined });
	assert.deepEqual(seen, [{ maxTokens: 4096, temperature: 0.4 }, { maxTokens: 800, temperature: 0 }, { maxTokens: 4096, temperature: 0.4 }]);
});

test("P0: native API-key login/logout and source labels work without ambient credentials", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials, authContext: { ...noEnv, env: async (name) => name === "DEEPSEEK_API_KEY" ? "p0-env-key" : undefined } });
	models.setProvider(native("deepseek"));
	assert.equal((await models.checkAuth("deepseek"))?.source, "DEEPSEEK_API_KEY");
	await models.login("deepseek", "api_key", { prompt: async (prompt) => { assert.equal(prompt.type, "secret"); return "p0-stored-key"; }, notify: () => {} });
	assert.equal((await models.getAuth("deepseek"))?.source, "stored credential");
	await models.logout("deepseek");
	assert.equal((await models.checkAuth("deepseek"))?.source, "DEEPSEEK_API_KEY", "logout does not unset the environment");
});

for (const provider of catalog.filter((provider) => provider.auth.oauth)) {
	test(`P0: ${provider.id} OAuth flow lazily loads and derives auth offline`, async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify(provider.id, async () => oauth);
		const models = createModels({ credentials, authContext: noEnv }); models.setProvider(provider);
		const result = await models.getAuth(provider.id, { signal: AbortSignal.timeout(2000) });
		assert.equal(result?.source, "OAuth");
		assert.ok(result?.auth.apiKey || result?.auth.headers?.Authorization);
	});
}
