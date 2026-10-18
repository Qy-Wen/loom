import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { emptyChatConfig } from "@loom/agent/chat-models";
import { applyChatSettingsPatch, chatConfigForPatch, chatSettingsPatchSchema, parseChatSettingsPatch, publicChatSettings } from "../src/main/tools/chat-settings-tools.ts";
import { ChatModelService } from "../src/main/models/chat-model-service.ts";
import { ChatCredentialStore } from "../src/main/models/chat-credential-store.ts";
import { ChatConfigStore } from "../src/main/models/chat-config-store.ts";
import { ChatCatalogStore } from "../src/main/models/chat-catalog-store.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";

async function workspace(t: { after(fn: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "loom-chat-tools-"));
	t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
	const stores = { config: new ChatConfigStore(join(dir, "config.json")), credentials: new ChatCredentialStore(join(dir, "credentials.json"), testChatCipher()), catalog: new ChatCatalogStore(join(dir, "catalog.json")) };
	return { dir, stores };
}
const model = { id: "demo", reasoning: true, input: ["text", "image"] as ("text" | "image")[], contextWindow: 128000, maxTokens: 8192 };
const customPatch = () => parseChatSettingsPatch({ upsert: [{ id: "tool-custom", kind: "custom", requestUrl: "http://localhost:1234/v2/responses", models: [structuredClone(model)], apiKey: "TOOL_PRIVATE" }] });

test("tool schema includes native model capabilities, URL inference, enablement and write-only API keys", () => {
	const schema = JSON.stringify(chatSettingsPatchSchema());
	for (const field of ["thinkingLevelMap", "contextWindow", "requestUrl", "apiKey", "clearApiKey", "modelEnabled", "modelOverrides"]) assert.ok(schema.includes(field));
	assert.ok(!schema.includes('"default"'));
});

test("Chat patches infer protocols, merge switches and retain independent conversation defaults", () => {
	const created = chatConfigForPatch(emptyChatConfig(), customPatch());
	const provider = created.providers[0]!;
	assert.ok(provider.kind === "custom"); assert.equal(provider.api, "openai-responses"); assert.equal(provider.baseUrl, "http://localhost:1234/v2");
	assert.ok(!JSON.stringify(created).includes("TOOL_PRIVATE"));
	assert.throws(() => chatConfigForPatch(emptyChatConfig(), parseChatSettingsPatch({ upsert: [{ id: "openai", requestUrl: "https://example.com/responses" }] })), /only for custom/);
	assert.equal(chatConfigForPatch(emptyChatConfig(), parseChatSettingsPatch({ upsert: [{ id: "openai", baseUrl: "https://example.com/v2", modelEnabled: { demo: true } }] })).providers[0]!.kind, "builtin");
	created.default = { provider: provider.id, modelId: "demo", thinkingLevel: "high" };
	provider.modelEnabled = { demo: true, other: false };
	const next = chatConfigForPatch(created, parseChatSettingsPatch({ upsert: [{ id: provider.id, modelEnabled: { demo: false } }] }));
	assert.deepEqual(next.providers[0]!.modelEnabled, { demo: false, other: false }); assert.deepEqual(next.default, created.default);
	assert.equal(chatConfigForPatch(next, parseChatSettingsPatch({ remove: [provider.id] })).default, undefined);
	assert.equal(chatConfigForPatch(next, parseChatSettingsPatch({ upsert: [{ id: provider.id, models: [{ ...model, id: "renamed" }] }] })).default, undefined);
	assert.equal(created.providers[0]!.modelEnabled!.demo, true);
});

for (const value of [
	{}, { upsert: [{ id: "p", apiKey: "PRIVATE", clearApiKey: true }] }, { upsert: [{ id: "p", apiKey: " " }] },
	{ upsert: [{ id: "p", requestUrl: "https://example.com/responses", api: "openai-responses" }] },
	{ upsert: [{ id: "p" }, { id: "p" }] }, { upsert: [{ id: "p" }], remove: ["p"] }, { default: { provider: "p" } },
] as const) test("invalid Chat tool patches reject without echoing secrets", () => {
	assert.throws(() => parseChatSettingsPatch(value), (error) => error instanceof Error && !error.message.includes("PRIVATE"));
});

test("Agent config/key writes use encrypted storage, browsable catalogs and OAuth-safe clearing", async (t) => {
	const { stores } = await workspace(t);
	const service = new ChatModelService(stores, { authContext: { env: async () => undefined, fileExists: async () => false } }); await service.initialize();
	await applyChatSettingsPatch(service, customPatch());
	const view = await publicChatSettings(service, "tool-custom");
	assert.equal(view.providers[0]!.hasApiKey, true); assert.equal(view.models[0]!.available, true); assert.deepEqual(view.models[0]!.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
	assert.ok(view.catalog.some((provider) => provider.id === "anthropic")); assert.ok(!JSON.stringify(view).includes("PRIVATE"));
	assert.ok(!(await readFile(stores.config.file.path, "utf8")).includes("PRIVATE")); assert.ok(!(await readFile(stores.credentials.file.path, "utf8")).includes("PRIVATE"));
	await applyChatSettingsPatch(service, parseChatSettingsPatch({ upsert: [{ id: "tool-custom", enabled: false }] }));
	assert.equal((await publicChatSettings(service)).providers[0]!.hasApiKey, true, "disabled does not mean no stored key");
	await applyChatSettingsPatch(service, parseChatSettingsPatch({ upsert: [{ id: "tool-custom", enabled: true, apiKey: "REPLACED_PRIVATE" }] }));
	const replacement = await stores.credentials.read("tool-custom"); assert.ok(replacement?.type === "api_key"); assert.equal(replacement.key, "REPLACED_PRIVATE");
	await service.stores.credentials.setSecret("tool-custom", "header", "HEADER_PRIVATE");
	await applyChatSettingsPatch(service, parseChatSettingsPatch({ upsert: [{ id: "tool-custom", headers: { "X-Proxy-Auth": "header" }, clearApiKey: true }] }));
	assert.equal((await publicChatSettings(service)).providers[0]!.hasApiKey, false);
	assert.equal(await stores.credentials.getSecret("tool-custom", "header"), "HEADER_PRIVATE");
	assert.equal((await publicChatSettings(service)).providers[0]!.hasHeaders, true);
	assert.ok(!JSON.stringify(await publicChatSettings(service)).includes('"headers"'));
	const oauth = { type: "oauth", access: "ACCESS_PRIVATE", refresh: "REFRESH_PRIVATE", expires: Date.now() + 60_000 } as const;
	await stores.credentials.modify("tool-custom", async () => oauth);
	await applyChatSettingsPatch(service, parseChatSettingsPatch({ upsert: [{ id: "tool-custom", clearApiKey: true }] }));
	assert.deepEqual(await stores.credentials.read("tool-custom"), oauth);
	await applyChatSettingsPatch(service, parseChatSettingsPatch({ upsert: [{ id: "openai", enabled: false }] }));
	const catalog = await publicChatSettings(service, "openai"); assert.ok(catalog.models.length > 0);
	assert.equal((await publicChatSettings(service)).models.length, 0);
	assert.ok(!JSON.stringify(catalog).includes("PRIVATE"));
});

test("invalid models and unavailable encryption never publish a replacement or echo submitted keys", async (t) => {
	const { stores } = await workspace(t);
	const service = new ChatModelService(stores, { authContext: { env: async () => undefined, fileExists: async () => false } });
	await service.initialize();
	const secret = "FAILED_PRIVATE";
	const invalid = customPatch(); invalid.upsert![0]!.models![0]!.contextWindow = 0;
	await assert.rejects(() => applyChatSettingsPatch(service, invalid), (error) => error instanceof Error && !error.message.includes(secret));
	assert.deepEqual(service.config, emptyChatConfig());
	stores.credentials.cipher.available = () => false;
	const patch = customPatch(); patch.upsert![0]!.apiKey = secret;
	await assert.rejects(() => applyChatSettingsPatch(service, patch), (error) => error instanceof Error && !error.message.includes(secret));
	assert.deepEqual(service.config, emptyChatConfig());
	assert.equal(await stores.config.file.read(), undefined);
	assert.equal(await stores.credentials.file.read(), undefined);
});

test("key-only edits reject busy providers without publishing config or overwriting credentials", async (t) => {
	const { stores } = await workspace(t); const faux = fauxProvider();
	const service = new ChatModelService(stores, { authContext: { env: async () => undefined, fileExists: async () => false }, apis: { "openai-responses": faux.provider } });
	await service.initialize(); await applyChatSettingsPatch(service, customPatch());
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("done"); }]);
	const result = service.models.completeSimple(service.models.getModel("tool-custom", "demo")!, { messages: [] }); await entered.promise;
	try {
		const before = await readFile(stores.config.file.path, "utf8");
		await assert.rejects(() => applyChatSettingsPatch(service, parseChatSettingsPatch({ upsert: [{ id: "tool-custom", name: "changed", apiKey: "REPLACEMENT_PRIVATE" }] })), /busy/);
		assert.equal(await readFile(stores.config.file.path, "utf8"), before);
		const key = await stores.credentials.read("tool-custom"); assert.ok(key?.type === "api_key"); assert.equal(key.key, "TOOL_PRIVATE");
	} finally { release.resolve(); await result; }
});
