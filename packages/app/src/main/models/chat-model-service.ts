import type { AssistantMessage, AssistantMessageEventStream, AuthContext, AuthInteraction, AuthPrompt, AuthType, Credential, CredentialStore } from "@earendil-works/pi-ai";
import { createModels, clampThinkingLevel, getSupportedThinkingLevels, type Models, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { assembleChatProviders, chatPriceSource, type ChatProviderAssemblyOptions } from "@loom/agent/chat-runtime";
import { emptyChatConfig, parseChatConfig, type ChatModelsConfig, type ChatSelection } from "@loom/agent/chat-models";
import type { ChatAuthStatus, ChatModelView } from "../../shared/chat-models.ts";
import type { ChatConfigStore } from "./chat-config-store.ts";
import type { ChatCredentialStore } from "./chat-credential-store.ts";
import type { ChatCatalogStore } from "./chat-catalog-store.ts";

type ApiKeyEditInteraction = Omit<AuthInteraction, "prompt"> & {
	/** Initial secrets may only leave Main in the explicit API-key editor's prompt event. */
	prompt: (prompt: AuthPrompt & { initialValue?: string }) => Promise<string>;
};
type ChatStores = { config: ChatConfigStore; credentials: ChatCredentialStore; catalog: ChatCatalogStore };
export type ChatModelServiceOptions = Pick<ChatProviderAssemblyOptions, "builtins" | "apis"> & {
	authContext?: AuthContext;
	/** Host reserves the public Session line while checking owned work and publishing changes. */
	withIdleProviders?: <T>(ids: readonly string[], operation: () => Promise<T>) => Promise<T>;
};
const authHeader = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i;

/** Main-owned, long-lived Models. DTO methods never return runtime models/auth/header values. */
export class ChatModelService {
	readonly models: Models;
	readonly stores: ChatStores;
	readonly options: ChatModelServiceOptions;
	readonly #native: MutableModels;
	readonly #builtins: readonly Provider[];
	#providers = new Map<string, Provider>();
	#config = emptyChatConfig();
	#initialized = false;
	#initialization?: Promise<void>;
	readonly #active = new Map<string, number>();
	readonly #mutating = new Set<string>();
	#changing = false;
	readonly #secrets = new Set<string>();
	readonly #secretListeners = new Set<(values: readonly string[]) => void>();
	readonly #refreshErrors = new Map<string, string>();

	constructor(stores: ChatStores, options: ChatModelServiceOptions = {}) {
		this.stores = stores; this.options = options;
		this.#builtins = options.builtins ?? builtinProviders();
		const credentials: CredentialStore = {
			read: async (...args) => { const value = await stores.credentials.read(...args); this.rememberCredential(value); return value; },
			modify: async (id, fn, opts) => stores.credentials.modify(id, async (current) => {
				this.rememberCredential(current); const next = await fn(current); this.rememberCredential(next); return next;
			}, opts),
			delete: (...args) => stores.credentials.delete(...args), list: (...args) => stores.credentials.list(...args),
		};
		this.#native = createModels({ credentials, modelsStore: stores.catalog, authContext: options.authContext });
		this.models = this.requestBoundary(this.#native);
	}
	get config(): ChatModelsConfig { return structuredClone(this.#config); }
	get defaultSelection(): ChatSelection | undefined { return this.#config.default && structuredClone(this.#config.default); }
	validateSelection(raw: unknown): ChatSelection {
		if (!raw || typeof raw !== "object") throw new Error("Invalid model selection");
		const draft = raw as { provider?: unknown; modelId?: unknown; thinkingLevel?: unknown };
		if (typeof draft.provider !== "string" || !draft.provider.trim() || typeof draft.modelId !== "string" || !draft.modelId.trim()) throw new Error("Model selection needs a provider and a model");
		const model = this.models.getModel(draft.provider, draft.modelId);
		if (!model) throw new Error("Unknown Chat model");
		if (!this.isModelEnabled(draft.provider, draft.modelId)) throw new Error("Chat model is disabled");
		let thinkingLevel: ChatSelection["thinkingLevel"] = "off";
		if (typeof draft.thinkingLevel === "string" && draft.thinkingLevel !== "off") {
			const levels = getSupportedThinkingLevels(model);
			if (!levels.some((level) => level === draft.thinkingLevel)) throw new Error(`Thinking level ${draft.thinkingLevel} is not supported by this model`);
			thinkingLevel = draft.thinkingLevel as ChatSelection["thinkingLevel"];
		}
		return { provider: draft.provider, modelId: draft.modelId, thinkingLevel };
	}
	isModelEnabled(providerId: string, modelId: string): boolean {
		const provider = this.#config.providers.find((entry) => entry.id === providerId);
		return !!provider?.enabled && provider.modelEnabled?.[modelId] !== false;
	}
	/** Remember only explicit composer choices; Settings never chooses a model. */
	async rememberSelection(selection: ChatSelection): Promise<void> {
		if (!this.isModelEnabled(selection.provider, selection.modelId)) throw new Error("Chat model is disabled");
		await this.save({ ...this.config, default: selection });
	}
	/** Prefer the remembered choice, then the first enabled, available text model in configuration order. */
	async selectionForNewSession(): Promise<ChatSelection | undefined> {
		const selection = this.defaultSelection;
		const available = new Map<string, Awaited<ReturnType<Models["getAvailable"]>>>();
		const candidates = async (provider: string) => {
			if (!available.has(provider)) {
				try { available.set(provider, await this.#native.getAvailable(provider, { signal: AbortSignal.timeout(5000) })); }
				catch { available.set(provider, []); }
			}
			return available.get(provider)!.filter((model) => model.input.includes("text") && this.isModelEnabled(provider, model.id));
		};
		if (selection && this.isModelEnabled(selection.provider, selection.modelId)
			&& (await candidates(selection.provider)).some((model) => model.id === selection.modelId)) return selection;
		for (const provider of this.#config.providers) {
			if (!provider.enabled) continue;
			const model = (await candidates(provider.id))[0];
			if (model) return { provider: provider.id, modelId: model.id, thinkingLevel: clampThinkingLevel(model, "off") };
		}
		return undefined;
	}
	onSecrets(listener: (values: readonly string[]) => void): () => void {
		this.#secretListeners.add(listener); listener([...this.#secrets]); return () => { this.#secretListeners.delete(listener); };
	}
	private remember(values: readonly (string | undefined)[]): void {
		let changed = false;
		for (const value of values) if (value && !this.#secrets.has(value)) { this.#secrets.add(value); changed = true; }
		if (changed) for (const listener of this.#secretListeners) { try { listener([...this.#secrets]); } catch { /* Diagnostics cannot fail auth. */ } }
	}
	private rememberCredential(credential: Credential | undefined): void {
		const visit = (value: unknown): void => {
			if (typeof value === "string") this.remember([value]);
			else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) if (key !== "type") visit(entry);
		};
		if (credential) visit(credential);
	}
	private redact(text: string): string {
		for (const value of [...this.#secrets].sort((a, b) => b.length - a.length)) text = text.split(value).join("[redacted]");
		return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]");
	}
	private protectStream(stream: AssistantMessageEventStream, id: string): AssistantMessageEventStream {
		const safe = (message: AssistantMessage): AssistantMessage => message.errorMessage ? { ...message, errorMessage: this.redact(message.errorMessage) } : message;
		const result = stream.result().then(safe).finally(() => {
			const count = (this.#active.get(id) ?? 1) - 1;
			if (count) this.#active.set(id, count); else this.#active.delete(id);
		});
		void result.catch(() => {});
		return new Proxy(stream, { get(target, key) {
			if (key === "result") return () => result;
			if (key === Symbol.asyncIterator) return async function* () {
				for await (const event of target) yield event.type === "error" ? { ...event, error: safe(event.error) } : event;
			};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		} });
	}
	private requestBoundary(native: Models): Models {
		const service = this;
		const start = (model: Parameters<Models["streamSimple"]>[0], run: () => AssistantMessageEventStream) => {
			if (service.#mutating.has(model.provider)) return lazyStream(model, async () => { throw new Error("Chat provider is being updated; retry after settings finish"); });
			if (!service.isModelEnabled(model.provider, model.id)) return lazyStream(model, async () => { throw new Error("Chat model is disabled; choose an enabled model in the composer"); });
			service.#active.set(model.provider, (service.#active.get(model.provider) ?? 0) + 1);
			try { return service.protectStream(run(), model.provider); }
			catch { service.#active.set(model.provider, (service.#active.get(model.provider) ?? 1) - 1); throw new Error("Chat request could not start"); }
		};
		let boundary: Models;
		boundary = new Proxy(native, { get(target, key) {
			if (key === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => start(args[0], () => target.streamSimple(...args));
			if (key === "stream") return (...args: Parameters<Models["stream"]>) => start(args[0], () => target.stream(...args));
			if (key === "streamDeferred") return (...args: Parameters<Models["streamDeferred"]>) => start(args[0], () => target.streamDeferred(...args));
			if (key === "completeSimple") return (...args: Parameters<Models["completeSimple"]>) => boundary.streamSimple(...args).result();
			if (key === "complete") return (...args: Parameters<Models["complete"]>) => boundary.stream(...args).result();
			if (key === "fetchDeferred") return (...args: Parameters<Models["fetchDeferred"]>) => boundary.streamDeferred(...args).result();
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		} });
		return boundary;
	}
	private async assemble(input: ChatModelsConfig): Promise<{ config: ChatModelsConfig; providers: Map<string, Provider> }> {
		const config = parseChatConfig(input);
		const headers = new Map<string, Record<string, string>>();
		for (const provider of config.providers) {
			if (!provider.enabled) continue;
			const resolved: Record<string, string> = {};
			for (const [name, reference] of Object.entries(provider.headers ?? {})) {
				const value = await this.stores.credentials.getSecret(provider.id, reference);
				if (value === undefined) throw new Error("Chat header secret is missing; repair provider configuration");
				if (/[\r\n\0]/.test(value)) throw new Error("Invalid Chat header value");
				resolved[name] = value; this.remember([value]);
			}
			if (Object.keys(resolved).length) headers.set(provider.id, resolved);
		}
		const providers = assembleChatProviders(config, { ...this.options, builtins: this.#builtins, headers,
			onRequestAuth: (options) => { this.remember([options.apiKey, ...Object.entries(options.headers ?? {}).filter(([name]) => authHeader.test(name)).map(([, value]) => value ?? undefined)]); },
		});
		if (config.default) {
			const model = providers.get(config.default.provider)?.getModels().find((model) => model.id === config.default!.modelId);
			if (model) config.default.thinkingLevel = clampThinkingLevel(model, config.default.thinkingLevel);
		}
		return { config, providers };
	}
	private publish(config: ChatModelsConfig, providers: Map<string, Provider>, changed: readonly string[]): void {
		for (const id of changed) {
			const entry = config.providers.find((provider) => provider.id === id);
			if (entry?.enabled) this.#native.setProvider(providers.get(id)!); else this.#native.deleteProvider(id);
			this.#refreshErrors.delete(id);
		}
		for (const [id, provider] of this.#providers) if (!changed.includes(id) && providers.has(id)) providers.set(id, provider);
		this.#config = config; this.#providers = providers;
	}
	private async mutation<T>(ids: readonly string[], operation: () => Promise<T>): Promise<T> {
		if (this.#changing) throw new Error("Chat settings are already being updated");
		if (ids.some((id) => (this.#active.get(id) ?? 0) > 0)) throw new Error("Chat provider is busy");
		this.#changing = true; for (const id of ids) this.#mutating.add(id);
		try { return await (this.options.withIdleProviders ? this.options.withIdleProviders(ids, operation) : operation()); }
		finally { this.#changing = false; for (const id of ids) this.#mutating.delete(id); }
	}

	/** First run without saved configuration: native DeepSeek from env; the key stays environmental. */
	async initialize(env: NodeJS.ProcessEnv = process.env): Promise<void> {
		if (this.#initialization) return this.#initialization;
		if (this.#initialized) return;
		this.#initialization = (async () => {
			const input = (await this.stores.config.file.read()) ?? this.envBootstrap(env);
			const prepared = await this.assemble(input);
			if (JSON.stringify(input) !== JSON.stringify(prepared.config)) await this.stores.config.save(prepared.config);
			this.publish(prepared.config, prepared.providers, prepared.config.providers.map((provider) => provider.id));
			await this.refresh({ allowNetwork: false });
			this.#initialized = true;
		})();
		try { await this.#initialization; } finally { this.#initialization = undefined; }
	}
	private envBootstrap(env: NodeJS.ProcessEnv): ChatModelsConfig {
		const config = emptyChatConfig();
		if (!env.DEEPSEEK_API_KEY?.trim()) return config;
		config.providers.push({ kind: "builtin", id: "deepseek", enabled: true });
		return config;
	}
	async save(input: ChatModelsConfig, apiKeys: readonly { providerId: string; key: string | null }[] = []): Promise<void> {
		if (!this.#initialized) throw new Error("Chat runtime is not initialized");
		const prepared = await this.assemble(input);
		const old = new Map(this.#config.providers.map((provider) => [provider.id, JSON.stringify(provider)]));
		const next = new Map(prepared.config.providers.map((provider) => [provider.id, JSON.stringify(provider)]));
		const changed = [...new Set([...old.keys(), ...next.keys()])].filter((id) => old.get(id) !== next.get(id));
		for (const { providerId, key } of apiKeys) {
			if (!prepared.providers.get(providerId)?.auth.apiKey) throw new Error("Chat provider does not support API-key configuration");
			if (key !== null && !key.trim()) throw new Error("API key must not be empty; use clearApiKey instead");
			this.remember([key ?? undefined]);
		}
		// Include key-only edits in the same busy-provider admission guard as config changes.
		const affected = [...new Set([...changed, ...apiKeys.map((row) => row.providerId)])];
		await this.mutation(affected, async () => {
			for (const { providerId, key } of apiKeys) await this.writeApiKey(providerId, key);
			await this.stores.config.save(prepared.config);
			this.publish(prepared.config, prepared.providers, changed);
			// Restore offline without releasing the admission/publication guard after the config commit.
			if (affected.length) await this.refreshNative({ providers: affected, allowNetwork: false, signal: AbortSignal.timeout(10_000) });
		});
	}
	/** Run a provider login flow (API key or OAuth) and persist the returned credential. */
	async login(providerId: string, type: AuthType, interaction: ApiKeyEditInteraction, options?: { signal?: AbortSignal }): Promise<void> {
		if (!this.#initialized) throw new Error("Chat runtime is not initialized");
		const provider = this.#providers.get(providerId) ?? this.#builtins.find((row) => row.id === providerId);
		if (!provider) throw new Error("Unknown Chat provider");
		let firstSecret = true;
		await this.mutation([providerId], () => this.#native.login(providerId, type, {
			...interaction,
			prompt: async (prompt) => {
				if (type !== "api_key" || prompt.type !== "secret" || !firstSecret) return interaction.prompt(prompt);
				firstSecret = false;
				const parentSignal = prompt.signal ?? interaction.signal;
				const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(5000)]);
				const initialValue = await this.apiKeyForEdit(provider, signal);
				signal.throwIfAborted();
				return interaction.prompt({ ...prompt, ...(initialValue !== undefined ? { initialValue } : {}) });
			},
		}, { agentName: "Loom" }));
		await this.refreshNative({ providers: [providerId], allowNetwork: false, signal: options?.signal ?? AbortSignal.timeout(10_000) });
	}
	/** Read only stored/ambient API-key auth, never resolve or refresh OAuth tokens. */
	private async apiKeyForEdit(provider: Provider, signal: AbortSignal): Promise<string | undefined> {
		try {
			const credential = await this.stores.credentials.read(provider.id, { signal });
			this.rememberCredential(credential);
			if (credential?.type === "api_key" && credential.key !== undefined) return credential.key;
			const resolved = await provider.auth.apiKey?.resolve({
				ctx: this.options.authContext ?? defaultProviderAuthContext(),
				credential: credential?.type === "api_key" ? credential : undefined,
				signal,
			});
			this.remember([resolved?.auth.apiKey]);
			return resolved?.auth.apiKey;
		} catch {
			signal.throwIfAborted();
			throw new Error("Could not load the configured API key");
		}
	}
	private async writeApiKey(providerId: string, key: string | null): Promise<void> {
		try {
			if (key === null) { await this.stores.credentials.clearApiKey(providerId); return; }
			await this.stores.credentials.modify(providerId, async (current) => {
				this.rememberCredential(current);
				return { type: "api_key", key, ...(current?.type === "api_key" && current.env ? { env: current.env } : {}) };
			});
		} catch { throw new Error("Could not save the Chat API key"); }
	}
	async logout(providerId: string): Promise<void> {
		if (!this.#initialized) throw new Error("Chat runtime is not initialized");
		await this.mutation([providerId], () => this.#native.logout(providerId));
	}
	async refresh(options: { providers?: readonly string[]; allowNetwork?: boolean; force?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ aborted: boolean; errors: Record<string, string> }> {
		const ids = this.#native.getProviders().filter((provider) => provider.refreshModels && (!options.providers || options.providers.includes(provider.id))).map((provider) => provider.id);
		const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
		return this.mutation(ids, () => this.refreshNative({ ...options, providers: ids, signal }));
	}
	private async refreshNative(options: Parameters<Models["refresh"]>[0]): Promise<{ aborted: boolean; errors: Record<string, string> }> {
		const result = await this.#native.refresh(options);
		for (const id of options?.providers ?? []) this.#refreshErrors.delete(id);
		for (const id of result.errors.keys()) this.#refreshErrors.set(id, "catalog_refresh_failed");
		return { aborted: result.aborted, errors: Object.fromEntries([...result.errors.keys()].map((id) => [id, "catalog_refresh_failed"])) };
	}
	async view(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ config: ChatModelsConfig; models: ChatModelView[]; auth: ChatAuthStatus[]; refreshErrors: Record<string, string> }> {
		const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs ?? 5000)]);
		const auth: ChatAuthStatus[] = [];
		const available = new Set<string>();
		for (const entry of this.#config.providers) {
			signal.throwIfAborted();
			if (!entry.enabled) { auth.push({ providerId: entry.id, configured: false, error: "provider_disabled" }); continue; }
			try {
				const status = await this.#native.checkAuth(entry.id, { signal });
				for (const model of await this.#native.getAvailable(entry.id, { signal })) available.add(`${entry.id}\0${model.id}`);
				auth.push({ providerId: entry.id, configured: !!status, ...(status ? { type: status.type, source: status.source } : { error: "auth_not_configured" }) });
			} catch { signal.throwIfAborted(); auth.push({ providerId: entry.id, configured: false, error: "auth_check_failed" }); }
		}
		const providers = new Map(this.#builtins.map((provider) => [provider.id, provider]));
		for (const [id, provider] of this.#providers) providers.set(id, provider);
		const models = [...providers.values()].flatMap((provider) => provider.getModels().filter((model) => model.input.includes("text")).map((model): ChatModelView => ({
			provider: model.provider, id: model.id, name: model.name, api: model.api, input: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
			thinkingLevels: getSupportedThinkingLevels(model), priceSource: chatPriceSource(this.#config.providers.find((entry) => entry.id === model.provider), model),
			...(chatPriceSource(this.#config.providers.find((entry) => entry.id === model.provider), model) !== "unknown" ? { cost: structuredClone(model.cost) } : {}),
			enabled: this.isModelEnabled(model.provider, model.id),
			available: available.has(`${model.provider}\0${model.id}`),
		})));
		return { config: this.config, models, auth, refreshErrors: Object.fromEntries(this.#refreshErrors) };
	}
}
