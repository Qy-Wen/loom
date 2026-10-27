import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProvider } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage as answer } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, CompactionTask, defineExtension, hook, LibraryRuntime } from "@loom/agent";
import type { ChatModelsConfig, ChatCustomProviderConfig } from "@loom/agent/chat-models";
import { ChatModelService } from "../src/main/models/chat-model-service.ts";
import { ChatCredentialStore } from "../src/main/models/chat-credential-store.ts";
import { ChatConfigStore } from "../src/main/models/chat-config-store.ts";
import { ChatCatalogStore } from "../src/main/models/chat-catalog-store.ts";
import { ChatService } from "../src/main/chat/chat-service.ts";
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

test("API-key editing prefills only its explicit secret prompt and cancellation keeps the stored key", async (t) => {
	const { stores } = await workspace(t);
	await stores.config.save(config());
	await stores.credentials.modify("local", async () => ({ type: "api_key", key: "STORED_PRIVATE" }));
	const service = new ChatModelService(stores, { authContext: noEnv }); await service.initialize();
	const observed = new Set<string>(); service.onSecrets((values) => values.forEach((value) => observed.add(value)));
	await assert.rejects(() => service.login("local", "api_key", {
		prompt: async (prompt) => { assert.equal(prompt.type, "secret"); assert.equal(prompt.initialValue, "STORED_PRIVATE"); throw new Error("cancelled"); },
		notify: () => {},
	}), /cancelled/);
	assert.equal((await stores.credentials.read("local"))?.type, "api_key");
	await service.login("local", "api_key", {
		prompt: async (prompt) => { assert.equal(prompt.initialValue, "STORED_PRIVATE"); return "REPLACEMENT_PRIVATE"; }, notify: () => {},
	});
	const credential = await stores.credentials.read("local");
	assert.ok(credential?.type === "api_key"); assert.equal(credential.key, "REPLACEMENT_PRIVATE");
	assert.ok(observed.has("STORED_PRIVATE")); assert.ok(observed.has("REPLACEMENT_PRIVATE"));
	assert.ok(!JSON.stringify(await service.view()).includes("PRIVATE"));
	assert.ok(!(await readFile(stores.credentials.file.path, "utf8")).includes("PRIVATE"));
});

test("API-key editor can prefill ambient keys without persisting them on cancel", async (t) => {
	const { stores } = await workspace(t);
	await stores.config.save({ version: 1, providers: [{ kind: "builtin", id: "deepseek", enabled: true }] });
	const service = new ChatModelService(stores, { authContext: { ...noEnv, env: async (name) => name === "DEEPSEEK_API_KEY" ? "ENV_PRIVATE" : undefined } });
	await service.initialize();
	await assert.rejects(() => service.login("deepseek", "api_key", {
		prompt: async (prompt) => { assert.equal(prompt.initialValue, "ENV_PRIVATE"); throw new Error("cancelled"); }, notify: () => {},
	}), /cancelled/);
	assert.deepEqual(await stores.credentials.list(), []);
	assert.ok(!JSON.stringify(await service.view()).includes("ENV_PRIVATE"));
});

test("login hands the installation device ID to flows that need it, and a flow without one fails with a readable error", async (t) => {
	const { stores } = await workspace(t);
	const faux = fauxProvider({ provider: "needs-id" });
	const seen: (string | undefined)[] = [];
	const oauth = { type: "oauth", access: "A", refresh: "R", expires: Date.now() + 60_000 } as const;
	const provider = createProvider({ id: "needs-id", models: faux.models, api: faux.provider, auth: { oauth: {
		name: "OAuth",
		login: async (_interaction, options) => {
			const id = options?.getDeviceId?.();
			seen.push(id);
			if (!id) throw new Error("Sign in requires a device ID");
			return oauth;
		},
		refresh: async () => oauth, toAuth: async () => ({ apiKey: "A" }),
	} } });
	await stores.config.save({ version: 1, providers: [{ kind: "builtin", id: "needs-id", enabled: true }] });
	const interaction = { prompt: async () => "", notify: () => {} };

	const without = new ChatModelService(stores, { builtins: [provider], authContext: noEnv }); await without.initialize();
	await assert.rejects(() => without.login("needs-id", "oauth", interaction), /device ID/);

	const id = "11111111-2222-4333-8444-555555555555";
	const service = new ChatModelService(stores, { builtins: [provider], authContext: noEnv, deviceId: async () => id }); await service.initialize();
	await service.login("needs-id", "oauth", interaction);
	assert.deepEqual(seen, [undefined, id]);
	assert.deepEqual(await stores.credentials.read("needs-id"), oauth);
});

test("OAuth edit flows never prefill access/refresh tokens or resolve OAuth for API-key editing", async (t) => {
	const { stores } = await workspace(t); let refreshes = 0;
	const faux = fauxProvider({ provider: "dual" });
	const oauth = { type: "oauth", access: "ACCESS_PRIVATE", refresh: "REFRESH_PRIVATE", expires: Date.now() + 60_000 } as const;
	const provider = createProvider({ id: "dual", models: faux.models, api: faux.provider, auth: {
		apiKey: { name: "API key", resolve: async () => undefined, login: async (interaction) => ({ type: "api_key", key: await interaction.prompt({ type: "secret", message: "Key" }) }) },
		oauth: {
			name: "OAuth",
			login: async (interaction) => { await interaction.prompt({ type: "secret", message: "OAuth verification" }); return oauth; },
			refresh: async () => { refreshes++; return oauth; }, toAuth: async () => ({ apiKey: "ACCESS_PRIVATE" }),
		},
	} });
	await stores.config.save({ version: 1, providers: [{ kind: "builtin", id: "dual", enabled: true }] });
	await stores.credentials.modify("dual", async () => oauth);
	const service = new ChatModelService(stores, { builtins: [provider], authContext: noEnv }); await service.initialize();
	for (const type of ["api_key", "oauth"] as const) await assert.rejects(() => service.login("dual", type, {
		prompt: async (prompt) => { assert.equal(prompt.initialValue, undefined); throw new Error("cancelled"); }, notify: () => {},
	}), /cancelled/);
	assert.equal(refreshes, 0); assert.deepEqual(await stores.credentials.read("dual"), oauth);
	assert.ok(!JSON.stringify(await service.view()).includes("PRIVATE"));
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
	assert.equal(await service.selectionForNewSession(), undefined);
});

test("sessions prefer remembered models and fall back to an enabled available model without replacing saved choices", async (t) => {
	const { dir, stores, cleanup } = await workspace(t);
	const provider = custom();
	provider.models.push({ ...provider.models[0]!, id: "other" });
	await stores.config.save({ version: 1, providers: [provider] });
	await stores.credentials.modify("local", async () => ({ type: "api_key", key: "test" }));
	const service = new ChatModelService(stores, { authContext: noEnv });
	await service.initialize();
	const selection = { provider: "local", modelId: "demo", thinkingLevel: "off" } as const;
	assert.deepEqual(await service.selectionForNewSession(), selection);
	assert.equal(service.defaultSelection, undefined, "automatic choices do not overwrite the remembered preference");
	const host = new ChatService({ models: service.models, chatDefault: () => service.selectionForNewSession() });
	cleanup.push(() => host.close()); await host.openLibrary(dir);
	const first = await host.createSession();
	assert.deepEqual(first.model, selection);
	await host.setSessionModel(first.id, selection);
	await service.rememberSelection(selection);
	assert.equal((await host.createSession()).model?.modelId, "demo");

	const input = service.config;
	input.providers[0]!.modelEnabled = { demo: false };
	await service.save(input);
	const view = await service.view();
	const disabled = view.models.find((model) => model.provider === "local" && model.id === "demo")!;
	assert.equal(disabled.enabled, false);
	assert.equal(disabled.available, true, "auth availability is not the enable switch");
	assert.equal(view.models.find((model) => model.provider === "local" && model.id === "other")!.enabled, true);
	assert.equal((await service.selectionForNewSession())?.modelId, "other");
	await assert.rejects(() => service.rememberSelection(selection), /disabled/);
	assert.equal((await host.getSession(first.id)).model?.modelId, "demo", "existing conversation selection is not rewritten");
	assert.equal((await host.createSession()).model?.modelId, "other");
	const blocked = await service.models.completeSimple(service.models.getModel("local", "demo")!, { messages: [] });
	assert.equal(blocked.stopReason, "error"); assert.match(blocked.errorMessage!, /disabled/);

	const reopened = new ChatModelService(stores, { authContext: noEnv });
	await reopened.initialize();
	assert.equal(reopened.isModelEnabled("local", "demo"), false);
	assert.equal((await reopened.selectionForNewSession())?.modelId, "other");
	const restored = reopened.config; restored.providers[0]!.modelEnabled = { demo: true };
	await reopened.save(restored);
	assert.deepEqual(await reopened.selectionForNewSession(), selection);
	await stores.credentials.delete("local");
	assert.equal(await reopened.selectionForNewSession(), undefined, "models without required credentials are unavailable");
});

test("automatic selection skips unavailable providers and disabled models in configuration order", async (t) => {
	const { stores } = await workspace(t);
	const provider = custom();
	provider.allowUnauthenticated = true;
	provider.models.push({ ...provider.models[0]!, id: "last" });
	provider.modelEnabled = { demo: false };
	await stores.config.save({ version: 1, providers: [custom("needs-auth"), { ...custom("disabled"), enabled: false }, provider] });
	const service = new ChatModelService(stores, { authContext: noEnv });
	await service.initialize();
	assert.equal((await service.selectionForNewSession())?.modelId, "last");
	await service.save({ version: 1, providers: [] });
	assert.equal(await service.selectionForNewSession(), undefined);
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
		const disabled = structuredClone(input); disabled.providers[0]!.modelEnabled = { demo: false };
		await assert.rejects(() => service.save(disabled), /busy/);
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

test("runtime env bootstrap makes DeepSeek selectable without overwriting the saved preference", async (t) => {
	const { stores } = await workspace(t);
	const env = { DEEPSEEK_API_KEY: "ENV_PRIVATE" };
	const service = new ChatModelService(stores, { authContext: { ...noEnv, env: async (name) => env[name as keyof typeof env] } });
	await service.initialize(env);
	assert.equal(service.defaultSelection, undefined);
	assert.equal((await service.selectionForNewSession())?.provider, "deepseek");
	assert.deepEqual(service.config.providers, [{ kind: "builtin", id: "deepseek", enabled: true }]);
	assert.deepEqual(await stores.credentials.list(), []); assert.ok(!JSON.stringify(await service.view()).includes("ENV_PRIVATE"));
	await service.save({ version: 1, providers: [] });
	const reopen = new ChatModelService(stores); await reopen.initialize(env);
	assert.deepEqual(reopen.config.providers, []);
});

test("injected Host defaults affect only new independent conversations and retain selections across fork/reopen", async (t) => {
	const { dir, stores, cleanup } = await workspace(t); const input = config(); input.providers.push(custom("second")); await stores.config.save(input);
	const service = new ChatModelService(stores, { authContext: noEnv }); await service.initialize();
	const host = new ChatService({ models: service.models, chatDefault: service.defaultSelection });
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
	let host: ChatService;
	const service = new ChatModelService(stores, { authContext: noEnv, apis: { "openai-completions": faux.provider }, withIdleProviders: (ids, operation) => host.withIdleChatProviders(ids, operation) });
	// Host is created before initialization so the gate also covers offline restoration.
	host = new ChatService({ models: service.models }); cleanup.push(() => host.close());
	await service.initialize(); host.setChatDefault(service.defaultSelection); await host.openLibrary(dir);
	const record = await host.createSession(); const conversation = await host.conversation(record.id);
	const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
	faux.setResponses([async () => { entered.resolve(); await release.promise; return answer("done"); }, answer("queued response")]);
	const submission = await conversation.submit({ type: "input", content: "work" }, context); await entered.promise;
	const queued = await conversation.submit({ type: "input", content: "queued work" }, context);
	try {
		const changed = structuredClone(input); changed.providers[0]!.enabled = false;
		await assert.rejects(() => service.save(changed), /busy/);
		await assert.rejects(() => service.save(input, [{ providerId: "local", key: "busy-private" }]), /busy/);
		assert.equal(await stores.credentials.read("local"), undefined);
		await assert.rejects(() => host.withIdleChatProviders(["local"], async () => {}), /busy/);
		await service.save({ ...input, default: { ...input.default!, thinkingLevel: "off" } });
	} finally { release.resolve(); await submission.wait(context); await queued.wait(context); }
	// Compaction hooks are busy even before a provider stream starts.
	const compactEntered = Promise.withResolvers<void>(); const compactRelease = Promise.withResolvers<void>();
	const compactHook = defineExtension({ name: "test.compact", hooks: [hook(CompactionTask, { beforeCompact: async () => {
		compactEntered.resolve(); await compactRelease.promise; return { summary: "summary" };
	} })] });
	host.requireRuntime().registry.install(compactHook); await conversation.configure({ extensions: { add: [compactHook] } }, context);
	await conversation.commit(async (tx) => { for (let i = 0; i < 4; i++) await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "old context ".repeat(5000), timestamp: i }] }); }, context);
	const task = await conversation.compact(undefined, context); await compactEntered.promise;
	try {
		await assert.rejects(() => host.withIdleChatProviders(["local"], async () => {}), /busy/);
		await assert.rejects(() => service.save(input, [{ providerId: "local", key: "compact-private" }]), /busy/);
		assert.equal(await stores.credentials.read("local"), undefined);
	}
	finally { compactRelease.resolve(); await host.requireRuntime().harness.waitForTask(task, context); }
	const changed = structuredClone(input); changed.providers[0]!.enabled = false; await service.save(changed);
	assert.equal(service.models.getProvider("local"), undefined);
	assert.equal((await conversation.agent(context)).model!.provider, "local", "disabling does not rewrite history or fail over");
});

test("real durable compaction preserves its explicit cap through the production Provider-default wrapper", { timeout: 10_000 }, async (t) => {
	const { dir, stores, cleanup } = await workspace(t); const input = config();
	(input.providers[0] as ChatCustomProviderConfig).allowUnauthenticated = true; input.providers[0]!.generation = { maxTokens: 4096 };
	await stores.config.save(input); const faux = fauxProvider();
	const service = new ChatModelService(stores, { authContext: noEnv, apis: { "openai-completions": faux.provider } }); await service.initialize();
	const owner = await LibraryRuntime.open(dir, { models: service.models, agent: { model: { provider: "local", modelId: "demo" } }, settings: { compaction: { reserveTokens: 1000, keepRecentTokens: 100, backgroundTokens: 0 }, retry: { enabled: false } } }, context);
	cleanup.push(() => owner.close(context)); const conversation = await owner.createConversation({}, context);
	await conversation.commit(async (tx) => { for (let i = 0; i < 6; i++) await tx.appendEntry(conversation.id, { kind: "test.user", model: [{ role: "user", content: "context ".repeat(100), timestamp: i }] }); }, context);
	faux.setResponses([(_messages, options) => { assert.equal(options!.maxTokens, 800); assert.equal(options!.cacheRetention, "none"); return answer("summary"); }]);
	const task = await conversation.compact(undefined, context);
	assert.equal((await owner.harness.waitForTask(task, context)).state.outcome.status, "completed");
});
