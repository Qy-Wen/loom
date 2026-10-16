import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_APIS, emptyChatConfig, parseChatConfig, type ChatCustomProviderConfig, type ChatModelsConfig } from "../src/chat-model-config.ts";

function custom(): ChatCustomProviderConfig { return { kind: "custom", id: "local", enabled: true, api: "openai-completions", baseUrl: "http://localhost:11434/v1", allowUnauthenticated: true,
	models: [{ id: "qwen:latest", reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 8192, thinkingLevelMap: { high: "high" }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
}; }
function fixture(): ChatModelsConfig { return { version: 1, providers: [custom()], default: { provider: "local", modelId: "qwen:latest", thinkingLevel: "high" } }; }

test("Chat config is versioned, detached, and preserves partial thinking maps and declared zero prices", () => {
	const input = fixture(); const parsed = parseChatConfig(input);
	assert.deepEqual(parsed, input);
	parsed.providers[0]!.name = "renamed";
	assert.equal(input.providers[0]!.name, undefined);
	assert.deepEqual(parseChatConfig(emptyChatConfig()), { version: 1, providers: [] });
});

for (const api of CHAT_APIS) test(`Chat config accepts explicit ${api} custom connections`, () => {
	const config = fixture(); (config.providers[0] as ChatCustomProviderConfig).api = api;
	assert.equal(parseChatConfig(config).providers[0]!.kind, "custom");
});

test("Chat config permits missing prices and unavailable/disabled defaults without inventing a replacement", () => {
	const provider = custom(); provider.enabled = false; delete provider.models[0]!.cost;
	assert.equal(parseChatConfig({ ...fixture(), providers: [provider] }).default!.provider, "local");
	assert.doesNotThrow(() => parseChatConfig({ version: 1, providers: [{ kind: "builtin", id: "openai", enabled: false }], default: { provider: "openai", modelId: "uncataloged-old-id", thinkingLevel: "off" } }));
});

test("Chat config treats header values as secret references and rejects duplicate names", () => {
	const provider = custom(); provider.headers = { Authorization: "proxy-auth" };
	assert.equal(parseChatConfig({ version: 1, providers: [provider] }).providers[0]!.headers!.Authorization, "proxy-auth");
	provider.headers.authorization = "other-secret";
	assert.throws(() => parseChatConfig({ version: 1, providers: [provider] }), /Duplicate Chat header/);
});

const invalid: [string, (config: ChatModelsConfig) => unknown][] = [
	["future version", (config) => ({ ...config, version: 99 })],
	["plaintext key", (config) => ({ ...config, apiKey: "PRIVATE" })],
	["duplicate provider", (config) => ({ ...config, providers: [custom(), custom()] })],
	["missing default provider", (config) => ({ ...config, default: { provider: "missing", modelId: "x", thinkingLevel: "off" } })],
	["missing custom model", (config) => ({ ...config, default: { provider: "local", modelId: "missing", thinkingLevel: "off" } })],
	["missing capabilities", (config) => ({ ...config, providers: [{ ...custom(), models: [{ id: "x" }] }] })],
	["non-text chat", (config) => ({ ...config, providers: [{ ...custom(), models: [{ ...custom().models[0], input: ["image"] }] }] })],
	["credential in URL", (config) => ({ ...config, providers: [{ ...custom(), baseUrl: "https://user:PRIVATE@example.com/v1" }] })],
	["credential in query", (config) => ({ ...config, providers: [{ ...custom(), baseUrl: "https://example.com/v1?api_key=PRIVATE" }] })],
	["credential in sampling", (config) => ({ ...config, providers: [{ ...custom(), generation: { samplingParams: { api_key: "PRIVATE" } } }] })],
	["non-JSON metadata", (config) => ({ ...config, providers: [{ ...custom(), generation: { samplingParams: { callback: () => {} } } }] })],
	["unsafe token limit", (config) => ({ ...config, providers: [{ ...custom(), models: [{ ...custom().models[0], contextWindow: Number.MAX_SAFE_INTEGER + 1 }] }] })],
	["unknown thinking level", (config) => ({ ...config, default: { ...config.default, thinkingLevel: "ultra" } })],
];
for (const [name, change] of invalid) test(`Chat config rejects ${name} without echoing values`, () => {
	assert.throws(() => parseChatConfig(change(fixture())), (error: unknown) => error instanceof Error && !error.message.includes("PRIVATE"));
});

test("Chat config preserves legacy context windows and independent advertised output ceilings", () => {
	const provider = custom(); provider.models[0]!.contextWindow = 1000;
	assert.equal((parseChatConfig({ version: 1, providers: [provider] }).providers[0] as ChatCustomProviderConfig).models[0]!.maxTokens, 8192);
});
