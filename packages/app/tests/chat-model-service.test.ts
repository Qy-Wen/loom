import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProvider } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, CompactionTask, defineExtension, hook, LibraryAgent } from "@loom/agent";
import type { ChatModelsConfig, ChatCustomProviderConfig } from "@loom/agent/chat-models";
import { ChatModelService } from "../src/main/chat-model-service.ts";
import { ChatCredentialStore } from "../src/main/chat-credential-store.ts";
import { ChatConfigStore } from "../src/main/chat-config-store.ts";
import { ChatCatalogStore } from "../src/main/chat-catalog-store.ts";
import { LibraryAgentHost } from "../src/main/library-agent-host.ts";
import { testChatCipher } from "./fixtures/chat-storage-cipher.ts";
const noEnv = { env: async () => undefined, fileExists: async () => false };
const custom = (id = "local"): ChatCustomProviderConfig => ({ kind: "custom", id, enabled: true, baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "demo", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 8192 }] });
const config = (): ChatModelsConfig => ({ version: 1, providers: [custom()], default: { provider: "local", modelId: "demo", thinkingLevel: "off" } });
async function workspace(t: { after(fn: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "loom-chat-service-"));
	const cleanup: (() => Promise<void>)[] = [];
	t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	const stores = { config: new ChatConfigStore(join(dir, "config.json")), credentials: new ChatCredentialStore(join(dir, "credentials.json"), testChatCipher()), catalog: new ChatCatalogStore(join(dir, "catalog.json")) };
	return { dir, stores, cleanup };
}

test("runtime registers enabled Providers only, browses native catalogs offline, and emits credential-free DTOs", async (t) => {
	const { stores } = await workspace(t); const input = config();
	input.providers.push({ kind: "builtin", id: "openai", enabled: false });
	input.providers[0]!.headers = { "X-Proxy-Auth": "proxy-secret" };
	await stores.credentials.setSecret("local", "proxy-secret", "HEADER_PRIVATE");
	await stores.credentials.modify("local", async () => ({ type: "api_key", key: "KEY_PRIVATE" }));
	await stores.config.save(input);
	const service = new ChatModelService(stores, { authContext: noEnv });
	await Promise.all([service.initialize(), service.initialize()]);
	assert.deepEqual(service.models.getProviders().map((provider) => provider.id), ["local"]);
	const view = await service.view();
	assert.ok(view.models.some((model) => model.provider === "openai"));
	const local = view.models.find((model) => model.provider === "local")!;
	assert.equal(local.available, true); assert.equal(local.priceSource, "unknown"); assert.equal(local.cost, undefined);
	assert.deepEqual(view.auth.find((auth) => auth.providerId === "local"), { providerId: "local", configured: true, type: "api_key", source: "stored credential" });
	assert.ok(!JSON.stringify(view).includes("KEY_PRIVATE")); assert.ok(!JSON.stringify(view).includes("HEADER_PRIVATE"));
	view.config.providers[0]!.name = "detached"; assert.equal(service.config.providers[0]!.name, undefined);
});

test("save validates before replacement, clamps native thinking, retains unknown selections and old collection identity", async (t) => {
	const { stores } = await workspace(t); const input = config();
	(input.providers[0] as ChatCustomProviderConfig).allowUnauthenticated = true;
	await stores.config.save(input); const service = new ChatModelService(stores, { authContext: noEnv }); await service.initialize();
	const models = service.models; const before = await readFile(stores.config.file.path, "utf8");
	await assert.rejects(() => service.save({ version: 1, providers: [{ kind: "builtin", id: "missing", enabled: true }] }), /Unknown built-in/);
	assert.equal(await readFile(stores.config.file.path, "utf8"), before);
	const changed = structuredClone(input); changed.default!.thinkingLevel = "max";
	await service.save(changed); assert.equal(service.defaultSelection!.thinkingLevel, "off");
	assert.equal(service.models, models);
	await service.save({ version: 1, providers: [{ kind: "builtin", id: "openai", enabled: false }], default: { provider: "openai", modelId: "historical-missing", thinkingLevel: "high" } });
	assert.equal(service.models.getModel("openai", "historical-missing"), undefined);
	assert.equal(service.defaultSelection!.modelId, "historical-missing");
});

test("request/auth errors are redacted before durable can checkpoint them, without changing streams/usage", async (t) => {
	const { stores } = await workspace(t); const input = config(); input.providers[0]!.headers = { "X-Proxy-Auth": "proxy-secret" };
	await stores.credentials.setSecret("local", "proxy-secret", "HEADER_PRIVATE");
	await stores.credentials.modify("local", async () => ({ type: "api_key", key: "KEY_PRIVATE" }));
	await stores.config.save(input); const faux = fauxProvider();
	const service = new ChatModelService(stores, { authContext: noEnv, apis: { "openai-completions": faux.provider } }); await service.initialize();
	const observed = new Set<string>(); service.onSecrets((values) => values.forEach((value) => observed.add(value)));
	faux.setResponses([(_messages, options) => {
		assert.equal(options!.apiKey, "KEY_PRIVATE"); assert.equal(options!.headers!["X-Proxy-Auth"], "HEADER_PRIVATE");
		return { ...answer(""), stopReason: "error", errorMessage: "Rejected KEY_PRIVATE and HEADER_PRIVATE" };
	}]);
	const stream = service.models.streamSimple(service.models.getModel("local", "demo")!, { messages: [] });
	for await (const event of stream) if (event.type === "error") assert.equal(event.error.errorMessage, "Rejected [redacted] and [redacted]");
	assert.equal((await stream.result()).errorMessage, "Rejected [redacted] and [redacted]");
	assert.ok(observed.has("KEY_PRIVATE")); assert.ok(observed.has("HEADER_PRIVATE"));
});

test("direct inference blocks Provider replacement but permits default-only saves and unchanged active options", async (t) => {
	const { stores } = await workspace(t); const input = config();
	(input.providers[0] as ChatCustomProviderConfig).allowUnauthenticated = true;
	input.providers[0]!.generation = { maxTokens: 64 }; await stores.config.save(input);
	const faux = fauxProvider(); const service = new ChatModelService(stores, { authContext: noEnv, apis: { "openai-completions": faux.provider } }); await service.initialize();
	const ready = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
	faux.setResponses([async (_messages, options) => { ready.resolve(); await release.promise; assert.equal(options!.maxTokens, 64); return answer("done"); }]);
	const request = service.models.completeSimple(service.models.getModel("local", "demo")!, { messages: [] }); await ready.promise;
	try {
		await service.save({ ...input, default: { ...input.default!, thinkingLevel: "max" } });
		const changed = structuredClone(input); changed.providers[0]!.generation = { maxTokens: 256 };
		await assert.rejects(() => service.save(changed), /busy/);
		assert.equal(service.config.providers[0]!.generation!.maxTokens, 64);
	} finally { release.resolve(); await request; }
	const changed = structuredClone(input); changed.providers[0]!.generation = { maxTokens: 256 }; await service.save(changed);
	assert.equal(service.config.providers[0]!.generation!.maxTokens, 256);
});

test("native dynamic refresh/cache restoration preserves native metadata and retains the last catalog on failures", async (t) => {
	const { stores } = await workspace(t); const faux = fauxProvider({ provider: "dynamic" }); let fetches = 0;
	const factory = () => createProvider({ id: "dynamic", models: [], auth: faux.provider.auth, api: faux.provider, fetchModels: async () => {
		fetches++; if (fetches > 1) throw new Error("PRIVATE_NETWORK_ERROR");
		return [{ ...faux.models[0]!, id: "published", contextWindow: 64000 }];
	} });
	const input: ChatModelsConfig = { version: 1, providers: [{ kind: "builtin", id: "dynamic", enabled: true, modelOverrides: { published: { contextWindow: 32000 } } }] };
	await stores.config.save(input);
	const service = new ChatModelService(stores, { builtins: [factory()], authContext: noEnv }); await service.initialize();
	assert.equal(fetches, 0); await service.refresh(); assert.equal(fetches, 1);
	assert.equal(service.models.getModel("dynamic", "published")!.contextWindow, 32000);
	const cached = (await stores.catalog.read("dynamic"))!.models[0]!;
	assert.ok(cached.type !== "image"); assert.equal(cached.contextWindow, 64000);
	assert.deepEqual((await service.refresh()).errors, { dynamic: "catalog_refresh_failed" });
	assert.equal(service.models.getModel("dynamic", "published")!.contextWindow, 32000);
	assert.ok(!JSON.stringify(await service.view()).includes("PRIVATE_NETWORK_ERROR"));
	const providerBefore = service.models.getProvider("dynamic"); await service.save({ ...input, default: { provider: "dynamic", modelId: "published", thinkingLevel: "off" } });
	assert.equal(service.models.getProvider("dynamic"), providerBefore, "default-only changes do not replace dynamic Providers");
	const reopened = new ChatModelService(stores, { builtins: [factory()], authContext: noEnv }); await reopened.initialize();
	assert.equal(fetches, 2); assert.equal(reopened.models.getModel("dynamic", "published")!.contextWindow, 32000);
});

test("runtime env bootstrap uses deepseek-flash and does not overwrite existing prepared configuration", async (t) => {
	const { stores } = await workspace(t);
	const env = { DEEPSEEK_API_KEY: "ENV_PRIVATE" };
	const service = new ChatModelService(stores, { authContext: { ...noEnv, env: async (name) => env[name as keyof typeof env] } });
	await service.initialize(env);
	assert.deepEqual(service.defaultSelection, { provider: "deepseek", modelId: "deepseek-flash", thinkingLevel: "off" });
	assert.deepEqual(await stores.credentials.list(), []); assert.ok(!JSON.stringify(await service.view()).includes("ENV_PRIVATE"));
	await service.save({ version: 1, providers: [] });
	const reopen = new ChatModelService(stores); await reopen.initialize(env);
	assert.deepEqual(reopen.config.providers, []);
});

test("injected Host defaults affect only new independent conversations and retain selections across fork/reopen", async (t) => {
	const { dir, stores, cleanup } = await workspace(t); const input = config(); input.providers.push(custom("second")); await stores.config.save(input);
	const service = new ChatModelService(stores, { authContext: noEnv }); await service.initialize();
	const host = new LibraryAgentHost({ models: service.models, chatDefault: service.defaultSelection });
	cleanup.push(() => host.close()); await host.openLibrary(dir);
	const first = await host.createSession(); const conversation = await host.conversation(first.id);
	const entry = await conversation.commit((tx) => tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "first", timestamp: 1 }] }), context);
	await service.save({ ...input, default: { provider: "second", modelId: "demo", thinkingLevel: "off" } }); host.setChatDefault(service.defaultSelection);
	const second = await host.createSession();
	assert.equal((await (await host.conversation(first.id)).agent(context)).model!.provider, "local");
	assert.equal((await (await host.conversation(second.id)).agent(context)).model!.provider, "second");
	const fork = await conversation.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
	assert.equal((await fork.agent(context)).model!.provider, "local");
	await host.close(); await host.openLibrary(dir);
	assert.equal((await (await host.conversation(first.id)).agent(context)).model!.provider, "local");
	assert.equal((await (await host.conversation(String(fork.id))).agent(context)).model!.provider, "local");
});

test("Host guards atomic Provider publication against running/queued/compaction work without blocking unrelated defaults", { timeout: 10_000 }, async (t) => {
	const { dir, stores, cleanup } = await workspace(t); const input = config(); (input.providers[0] as ChatCustomProviderConfig).allowUnauthenticated = true;
	await stores.config.save(input); const faux = fauxProvider();
	let host: LibraryAgentHost;
	const service = new ChatModelService(stores, { authContext: noEnv, apis: { "openai-completions": faux.provider }, withIdleProviders: (ids, operation) => host.withIdleChatProviders(ids, operation) });
	// Host is created before initialization so the gate also covers offline restoration.
	host = new LibraryAgentHost({ models: service.models }); cleanup.push(() => host.close());
	await service.initialize(); host.setChatDefault(service.defaultSelection); await host.openLibrary(dir);
	const record = await host.createSession(); const conversation = await host.conversation(record.id);
	const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
	faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("done"); }, answer("queued response")]);
	const submission = await conversation.submit({ type: "input", content: "work" }, context); await entered.promise;
	const queued = await conversation.submit({ type: "input", content: "queued work" }, context);
	try {
		const changed = structuredClone(input); changed.providers[0]!.enabled = false;
		await assert.rejects(() => service.save(changed), /busy/);
		await assert.rejects(() => host.withIdleChatProviders(["local"], async () => {}), /busy/);
		await service.save({ ...input, default: { ...input.default!, thinkingLevel: "off" } });
	} finally { release.resolve(); await submission.wait(context); await queued.wait(context); }
	// Compaction hooks are busy even before a provider stream starts.
	const compactEntered = Promise.withResolvers<void>(); const compactRelease = Promise.withResolvers<void>();
	const compactHook = defineExtension({ name: "test.compact", hooks: [hook(CompactionTask, { beforeCompact: async () => {
		compactEntered.resolve(); await compactRelease.promise; return { summary: "summary" };
	} })] });
	host.requireOwner().registry.install(compactHook); await conversation.configure({ extensions: { add: [compactHook] } }, context);
	await conversation.commit(async (tx) => { for (let i = 0; i < 4; i++) await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "old context ".repeat(5000), timestamp: i }] }); }, context);
	const task = await conversation.compact(undefined, context); await compactEntered.promise;
	try { await assert.rejects(() => host.withIdleChatProviders(["local"], async () => {}), /busy/); }
	finally { compactRelease.resolve(); await host.requireOwner().harness.waitForTask(task, context); }
	const changed = structuredClone(input); changed.providers[0]!.enabled = false; await service.save(changed);
	assert.equal(service.models.getProvider("local"), undefined);
	assert.equal((await conversation.agent(context)).model!.provider, "local", "disabling does not rewrite history or fail over");
});

test("real durable compaction preserves its explicit cap through the production Provider-default wrapper", { timeout: 10_000 }, async (t) => {
	const { dir, stores, cleanup } = await workspace(t); const input = config();
	(input.providers[0] as ChatCustomProviderConfig).allowUnauthenticated = true; input.providers[0]!.generation = { maxTokens: 4096 };
	await stores.config.save(input); const faux = fauxProvider();
	const service = new ChatModelService(stores, { authContext: noEnv, apis: { "openai-completions": faux.provider } }); await service.initialize();
	const owner = await LibraryAgent.open(dir, { models: service.models, agent: { model: { provider: "local", modelId: "demo" } }, settings: { compaction: { reserveTokens: 1000, keepRecentTokens: 100, backgroundTokens: 0 }, retry: { enabled: false } } }, context);
	cleanup.push(() => owner.close(context)); const conversation = await owner.createConversation({}, context);
	await conversation.commit(async (tx) => { for (let i = 0; i < 6; i++) await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "context ".repeat(100), timestamp: i }] }); }, context);
	faux.setResponses([(_messages, options) => { assert.equal(options!.maxTokens, 800); assert.equal(options!.cacheRetention, "none"); return answer("summary"); }]);
	const task = await conversation.compact(undefined, context);
	assert.equal((await owner.harness.waitForTask(task, context)).state.outcome.status, "completed");
});
