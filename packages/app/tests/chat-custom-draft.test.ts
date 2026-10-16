import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatCustomProviderConfig, ChatModelsConfig } from "@loom/agent/chat-models";
import { buildCustomProvider, customModelDraft, customProviderDraft, CustomDraftError, putCustomProvider } from "../src/renderer/settings/chat-custom-draft.ts";

const provider = (): ChatCustomProviderConfig => ({
	kind: "custom", id: "proxy", name: "Proxy", enabled: true, baseUrl: "http://localhost:1234/v1", api: "openai-completions",
	headers: { Authorization: "secret-ref" }, generation: { temperature: 0.4 }, modelEnabled: { demo: false },
	models: [{ id: "demo", name: "Demo", reasoning: true, input: ["text", "image"], contextWindow: 64000, maxTokens: 4096,
		compat: { supportsDeveloperRole: false }, thinkingLevelMap: { high: "enabled" }, generation: { maxTokens: 1000 },
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, api: "openai-responses",
	}],
});

test("new custom drafts stay local and require a real URL and model ID", () => {
	const draft = customProviderDraft();
	assert.equal(draft.requestUrl, ""); assert.equal(draft.models[0]!.id, "");
	assert.throws(() => buildCustomProvider("custom-new", draft), CustomDraftError);
	draft.requestUrl = " https://proxy.example.com/v1/chat/completions "; draft.name = " My proxy ";
	draft.models[0]!.id = " qwen:latest "; draft.models[0]!.name = " Qwen ";
	const built = buildCustomProvider("custom-new", draft);
	assert.equal(built.baseUrl, "https://proxy.example.com/v1"); assert.equal(built.name, "My proxy");
	assert.equal(built.models[0]!.id, "qwen:latest"); assert.equal(built.models[0]!.name, "Qwen");
	assert.equal(built.models[0]!.reasoning, false); assert.deepEqual(built.models[0]!.input, ["text"]);
	assert.equal(built.models[0]!.cost, undefined);
});

test("custom editing retains provider identity, secret references, unexposed model metadata and enable flags", () => {
	const original = provider(); const draft = customProviderDraft(original);
	draft.name = "Renamed proxy"; draft.requestUrl = "http://localhost:9999/v1/messages?beta=true";
	draft.models[0]!.id = "renamed"; draft.models[0]!.contextWindow = "128000";
	draft.models[0]!.image = false; draft.models[0]!.reasoning = false;
	const result = buildCustomProvider(original.id, draft, original);
	assert.equal(result.id, original.id); assert.equal(result.api, "anthropic-messages");
	assert.deepEqual(result.headers, original.headers); assert.deepEqual(result.generation, original.generation);
	assert.deepEqual(result.modelEnabled, { renamed: false });
	assert.deepEqual(result.models[0]!.compat, original.models[0]!.compat);
	assert.deepEqual(result.models[0]!.cost, original.models[0]!.cost);
	assert.deepEqual(result.models[0]!.generation, original.models[0]!.generation);
	assert.deepEqual(result.models[0]!.thinkingLevelMap, original.models[0]!.thinkingLevelMap);
	assert.equal(result.models[0]!.api, "openai-responses", "retain an explicit per-model protocol override");
	assert.equal(result.models[0]!.contextWindow, 128000); assert.deepEqual(result.models[0]!.input, ["text"]);
	assert.equal(original.models[0]!.id, "demo"); assert.equal(original.baseUrl, "http://localhost:1234/v1");
});

test("custom editors support multiple models, capability declaration, removal and optional display names", () => {
	const original = provider(); const draft = customProviderDraft(original);
	draft.name = " "; draft.models = [customModelDraft(1)];
	draft.models[0]!.id = "new"; draft.models[0]!.reasoning = true; draft.models[0]!.image = true;
	const result = buildCustomProvider(original.id, draft, original);
	assert.equal(result.name, undefined); assert.equal(result.models[0]!.name, undefined);
	assert.deepEqual(result.modelEnabled, {}); assert.equal(result.models[0]!.reasoning, true);
	assert.deepEqual(result.models[0]!.input, ["text", "image"]);
});

for (const [name, mutate, code] of [
	["credential URL", (draft: ReturnType<typeof customProviderDraft>) => { draft.requestUrl = "https://user:PRIVATE@example.com/v1/chat/completions"; }, "baseUrl"],
	["blank model ID", (draft: ReturnType<typeof customProviderDraft>) => { draft.models[0]!.id = " "; }, "modelIds"],
	["duplicate IDs", (draft: ReturnType<typeof customProviderDraft>) => { draft.models.push({ ...draft.models[0]!, key: 1, id: " demo " }); }, "modelIds"],
	["empty list", (draft: ReturnType<typeof customProviderDraft>) => { draft.models = []; }, "noModels"],
	["fractional context", (draft: ReturnType<typeof customProviderDraft>) => { draft.models[0]!.contextWindow = "1.5"; }, "tokenLimits"],
	["zero output", (draft: ReturnType<typeof customProviderDraft>) => { draft.models[0]!.maxTokens = "0"; }, "tokenLimits"],
] as const) test(`custom editor rejects ${name} without echoing input`, () => {
	const draft = customProviderDraft(provider()); mutate(draft);
	assert.throws(() => buildCustomProvider("proxy", draft, provider()), (error) => error instanceof CustomDraftError && error.code === code && !error.message.includes("PRIVATE"));
});

test("publishing edited models clears a missing remembered choice without selecting a fallback or changing the source", () => {
	const original = provider();
	const config: ChatModelsConfig = { version: 1, providers: [original], default: { provider: "proxy", modelId: "demo", thinkingLevel: "high" } };
	const draft = customProviderDraft(original); draft.models[0]!.id = "changed";
	const next = putCustomProvider(config, buildCustomProvider(original.id, draft, original));
	assert.equal(next.default, undefined); assert.equal(config.default!.modelId, "demo");
	assert.equal(config.providers[0]!.name, "Proxy");
	assert.equal(putCustomProvider(config, original).default!.modelId, "demo");
});
