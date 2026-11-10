import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { assembleChatProviders, chatGenerationOptions, chatPriceSource, mergeChatHeaders } from "../src/models/chat-provider.ts";
import type { ChatCustomProviderConfig } from "../src/models/chat-model-config.ts";
const noEnv = { env: async () => undefined, fileExists: async () => false };
const custom = (): ChatCustomProviderConfig => ({ kind: "custom", id: "local", enabled: true, baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "custom", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 8192 }] });

test("native assembly preserves every untouched built-in catalog and auth/filter/refresh identity", () => {
	const builtins = builtinProviders();
	const assembled = assembleChatProviders({ version: 1, providers: builtins.map((provider) => ({ kind: "builtin", id: provider.id, enabled: true })) }, { builtins });
	for (const provider of builtins) {
		const wrapped = assembled.get(provider.id)!;
		assert.equal(wrapped.auth, provider.auth);
		assert.equal(Boolean(wrapped.filterModels), Boolean(provider.filterModels));
		assert.equal(Boolean(wrapped.refreshModels), Boolean(provider.refreshModels));
		assert.deepEqual(wrapped.getAllModels!(), provider.getAllModels?.() ?? provider.getModels());
	}
});

test("native model overlays merge compat/maps/sampling without changing identity, protocol, prices, or source", () => {
	const faux = fauxProvider({ models: [{ id: "same", reasoning: true, contextWindow: 128000, maxTokens: 8192 }] });
	const base = faux.models[0]! as Model<Api>;
	base.compat = { supportsStore: false, supportsDeveloperRole: true, chatTemplateKwargs: { base: true } };
	base.thinkingLevelMap = { low: "low", max: "max" };
	base.samplingParams = { top_p: 0.8 }; base.samplingParamsByThinkingLevel = { high: { top_k: 8 } };
	const providers = assembleChatProviders({ version: 1, providers: [{ kind: "builtin", id: faux.provider.id, enabled: true, modelOverrides: {
		same: { contextWindow: 64000, thinkingLevelMap: { low: null }, compat: { supportsDeveloperRole: false, chatTemplateKwargs: { extra: true } }, samplingParams: { min_p: 0.1 }, samplingParamsByThinkingLevel: { high: { min_p: 0.2 } } },
	} }] }, { builtins: [faux.provider] });
	const model = providers.get(faux.provider.id)!.getModels()[0]!;
	assert.equal(model.id, base.id); assert.equal(model.provider, base.provider); assert.equal(model.api, base.api);
	assert.equal(model.contextWindow, 64000); assert.equal(base.contextWindow, 128000);
	assert.deepEqual(model.cost, base.cost);
	assert.deepEqual(model.compat, { supportsStore: false, supportsDeveloperRole: false, chatTemplateKwargs: { base: true, extra: true } });
	assert.deepEqual(model.thinkingLevelMap, { low: null, max: "max" });
	assert.ok(!getSupportedThinkingLevels(model).includes("low")); assert.ok(getSupportedThinkingLevels(model).includes("max"));
	assert.deepEqual(model.samplingParams, { top_p: 0.8, min_p: 0.1 });
	assert.deepEqual(model.samplingParamsByThinkingLevel, { high: { top_k: 8, min_p: 0.2 } });
});

test("generation defaults merge per field with model over provider and explicit over both", () => {
	assert.deepEqual(chatGenerationOptions({ maxTokens: 4096, temperature: 0.4, samplingParams: { top_p: 0.9, seed: 1 } }, { temperature: 0.2, samplingParams: { seed: 2 } }, { maxTokens: 800, temperature: 0, cacheRetention: "none", samplingParams: { top_p: 0.8 } }), { maxTokens: 800, temperature: 0, cacheRetention: "none", samplingParams: { top_p: 0.8, seed: 2 } });
	assert.equal(chatGenerationOptions({ maxTokens: 4096 }, undefined, { maxTokens: undefined }).maxTokens, 4096);
});

test("custom simple dispatch injects budgets without changing native stream results or placeholders", async () => {
	const faux = fauxProvider(); const config = custom(); config.allowUnauthenticated = true;
	config.generation = { maxTokens: 4096, temperature: 0.4 }; config.models[0]!.generation = { maxTokens: 1024 };
	const provider = assembleChatProviders({ version: 1, providers: [config] }, { apis: { "openai-completions": faux.provider } }).get("local")!;
	const models = createModels({ authContext: noEnv }); models.setProvider(provider);
	faux.setResponses([(_messages, options) => { assert.equal(options!.maxTokens, 1024); assert.equal(options!.temperature, 0.4); return answer("done"); },
		(_messages, options) => { assert.equal(options!.maxTokens, 800); assert.equal(options!.cacheRetention, "none"); return answer("summary"); }]);
	const model = provider.getModels()[0]!;
	assert.equal((await models.completeSimple(model, { messages: [] })).content[0]!.type, "text");
	await models.completeSimple(model, { messages: [] }, { maxTokens: 800, cacheRetention: "none" });
	assert.equal(chatPriceSource(config, model), "unknown");
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	config.models[0]!.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.equal(chatPriceSource(config, model), "override");
});

test("custom keyless is explicit, API-key auth uses only the stored credential, and OAuth is not invented", async () => {
	const config = custom(); const provider = assembleChatProviders({ version: 1, providers: [config] }).get("local")!;
	assert.equal(provider.auth.oauth, undefined);
	const credentials = new InMemoryCredentialStore(); const models = createModels({ credentials, authContext: noEnv }); models.setProvider(provider);
	assert.equal(await models.checkAuth("local"), undefined);
	await credentials.modify("local", async () => ({ type: "api_key", key: "FAKE_KEY" }));
	assert.equal((await models.getAuth("local"))!.auth.apiKey, "FAKE_KEY");
	assert.equal((await models.getAuth("local"))!.source, "stored credential");
});

test("native Copilot OAuth filtering and auth-derived endpoint survive custom endpoint/header overlays", async () => {
	const native = builtinProviders().find((provider) => provider.id === "github-copilot")!;
	const selected = native.getModels()[0]!;
	const provider = assembleChatProviders({ version: 1, providers: [{ kind: "builtin", id: native.id, enabled: true, baseUrl: "https://proxy.invalid/v1" }] }, { builtins: [native], headers: new Map([[native.id, { "X-Proxy-Auth": "FAKE_HEADER" }]]) }).get(native.id)!;
	const credentials = new InMemoryCredentialStore(); await credentials.modify(native.id, async () => ({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, availableModelIds: [selected.id] }));
	const models = createModels({ credentials, authContext: noEnv }); models.setProvider(provider);
	const available = await models.getAvailable(native.id); assert.equal(available.length, 1);
	const auth = await models.getAuth(available[0]!);
	assert.ok(auth!.auth.baseUrl!.includes("githubcopilot.com")); assert.equal(auth!.auth.headers!["X-Proxy-Auth"], "FAKE_HEADER");
});

for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const) test(`custom ${api} uses the native lazy protocol implementation`, async () => {
	const config = custom(); config.api = api;
	const provider = assembleChatProviders({ version: 1, providers: [config] }).get("local")!;
	const models = createModels({ authContext: noEnv }); models.setProvider(provider);
	let captured = false;
	const result = await models.completeSimple(provider.getModels()[0]!, { messages: [{ role: "user", content: "ping", timestamp: 1 }], tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }] }, { apiKey: "FAKE_KEY", maxTokens: 32, maxRetries: 0, signal: AbortSignal.timeout(2000), onPayload: () => { captured = true; throw new Error("NO_NETWORK"); } });
	assert.equal(captured, true); assert.match(result.errorMessage!, /NO_NETWORK/);
});

test("headers merge case-insensitively, and invalid Provider identities fail before publication", () => {
	assert.deepEqual(mergeChatHeaders({ Authorization: "base", "X-Foo": "one" }, { authorization: null, "x-foo": "two" }), { authorization: null, "x-foo": "two" });
	assert.throws(() => assembleChatProviders({ version: 1, providers: [{ kind: "builtin", id: "missing", enabled: true }] }), /Unknown built-in/);
	assert.throws(() => assembleChatProviders({ version: 1, providers: [{ ...custom(), id: "openai" }] }), /conflicts/);
});
