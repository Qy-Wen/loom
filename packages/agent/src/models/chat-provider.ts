import type { Api, Model, Provider, ProviderHeaders, ProviderStreams, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createProvider, isModelType } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { parseChatConfig, type ChatApi, type ChatGenerationDefaults, type ChatModelsConfig, type ChatProviderConfig } from "./chat-model-config.ts";

type ModelOverride = NonNullable<Extract<ChatProviderConfig, { kind: "builtin" }>["modelOverrides"]>[string];
export type ChatProviderAssemblyOptions = {
	/** Runtime-only resolved header values; never expose assembled models directly over IPC. */
	headers?: ReadonlyMap<string, Readonly<Record<string, string>>>;
	/** Tests can inject native-shaped factories/dispatchers without contacting a service. */
	builtins?: readonly Provider[];
	apis?: Partial<Record<ChatApi, ProviderStreams>>;
	/** Observe effective auth only in Main, before it could occur in a provider error. */
	onRequestAuth?: (options: { apiKey?: string; headers?: ProviderHeaders }) => void;
};

/** Case-insensitive, per-field replacement including null deletion markers used by pi-ai. */
export function mergeChatHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {};
	for (const source of sources) for (const [name, value] of Object.entries(source ?? {})) {
		for (const old of Object.keys(merged)) if (old.toLowerCase() === name.toLowerCase()) delete merged[old];
		Object.defineProperty(merged, name, { value, enumerable: true, writable: true, configurable: true });
	}
	return Object.keys(merged).length ? merged : undefined;
}

export function chatGenerationOptions(provider: ChatGenerationDefaults | undefined, model: ChatGenerationDefaults | undefined, explicit: SimpleStreamOptions | undefined): SimpleStreamOptions {
	const defaults = { ...provider, ...model };
	const options = { ...defaults, ...explicit };
	for (const key of ["maxTokens", "temperature", "cacheRetention"] as const) {
		if (options[key] === undefined) Object.assign(options, { [key]: defaults[key] });
	}
	if (provider?.samplingParams || model?.samplingParams || explicit?.samplingParams) {
		options.samplingParams = { ...provider?.samplingParams, ...model?.samplingParams, ...explicit?.samplingParams };
	}
	return options;
}

function mergeMetadata(model: Model<Api>, override: ModelOverride | undefined): Model<Api> {
	if (!override) return model;
	const { generation: _generation, ...fields } = override;
	const merged = { ...model, ...fields } as Model<Api>;
	if (fields.compat) {
		const compat = { ...model.compat, ...fields.compat } as Record<string, unknown>;
		for (const name of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"]) {
			const base = (model.compat as Record<string, unknown> | undefined)?.[name];
			const next = fields.compat[name];
			if (next && typeof next === "object" && !Array.isArray(next)) compat[name] = { ...(base as object | undefined), ...next };
		}
		merged.compat = compat;
	}
	if (fields.thinkingLevelMap) merged.thinkingLevelMap = { ...model.thinkingLevelMap, ...fields.thinkingLevelMap };
	if (fields.samplingParams) merged.samplingParams = { ...model.samplingParams, ...fields.samplingParams };
	if (fields.samplingParamsByThinkingLevel) {
		merged.samplingParamsByThinkingLevel = { ...model.samplingParamsByThinkingLevel };
		for (const level of Object.keys(fields.samplingParamsByThinkingLevel) as (keyof NonNullable<Model<Api>["samplingParamsByThinkingLevel"]>)[]) {
			merged.samplingParamsByThinkingLevel[level] = { ...model.samplingParamsByThinkingLevel?.[level], ...fields.samplingParamsByThinkingLevel[level] };
		}
	}
	return merged;
}

/** Native factory objects remain the owners of auth, filters, catalogs, and protocol dispatch. */
export function overlayChatProvider(provider: Provider, config: ChatProviderConfig, headers?: Readonly<Record<string, string>>, onRequestAuth?: ChatProviderAssemblyOptions["onRequestAuth"]): Provider {
	const settings = structuredClone(config);
	const modelSettings = (id: string): ModelOverride | undefined => settings.kind === "builtin"
		? Object.prototype.hasOwnProperty.call(settings.modelOverrides ?? {}, id) ? settings.modelOverrides![id] : undefined
		: settings.models.find((model) => model.id === id);
	const overlay = (model: Model<Api>): Model<Api> => {
		const merged = settings.kind === "builtin" ? mergeMetadata(model, modelSettings(model.id)) : model;
		return { ...merged, ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
			...(headers ? { headers: mergeChatHeaders(merged.headers, headers) as Record<string, string> } : {}),
		};
	};
	return new Proxy(provider, { get(target, key) {
		if (key === "name") return settings.name ?? target.name;
		if (key === "baseUrl") return settings.baseUrl ?? target.baseUrl;
		if (key === "getModels") return () => target.getModels().map(overlay);
		if (key === "getAllModels") return () => (target.getAllModels?.() ?? target.getModels()).map((model) => isModelType(model, "chat") ? overlay(model) : model);
		if (key === "streamSimple") return (...[model, transcript, explicit]: Parameters<Provider["streamSimple"]>) => {
			const options = chatGenerationOptions(settings.generation, modelSettings(model.id)?.generation, explicit);
			onRequestAuth?.(options);
			return target.streamSimple(model, transcript, options);
		};
		if (key === "stream") return (...args: Parameters<Provider["stream"]>) => { onRequestAuth?.(args[2] ?? {}); return target.stream(...args); };
		if (key === "fetchDeferred" && target.fetchDeferred) return (...args: Parameters<NonNullable<Provider["fetchDeferred"]>>) => { onRequestAuth?.(args[2] ?? {}); return target.fetchDeferred!(...args); };
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}

export function createChatCustomProvider(config: Extract<ChatProviderConfig, { kind: "custom" }>, apis?: ChatProviderAssemblyOptions["apis"]): Provider {
	const implementations: Record<ChatApi, ProviderStreams> = {
		"openai-completions": openAICompletionsApi(), "openai-responses": openAIResponsesApi(),
		"anthropic-messages": anthropicMessagesApi(), "google-generative-ai": googleGenerativeAIApi(), ...apis,
	};
	const models = config.models.map(({ generation: _generation, ...model }): Model<Api> => ({
		...model, name: model.name ?? model.id, api: model.api ?? config.api, provider: config.id, baseUrl: config.baseUrl,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
	return createProvider({ id: config.id, name: config.name, baseUrl: config.baseUrl, models, api: implementations,
		auth: { apiKey: { name: "API key", login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter API key" });
			interaction.signal.throwIfAborted(); return { type: "api_key", key };
		}, resolve: async ({ credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			return config.allowUnauthenticated ? { auth: {}, source: "no authentication" } : undefined;
		} } },
	});
}

/** Assemble before publishing: malformed config cannot leave a half-replaced execution collection. */
export function assembleChatProviders(input: ChatModelsConfig, options: ChatProviderAssemblyOptions = {}): Map<string, Provider> {
	const config = parseChatConfig(input);
	const native = new Map((options.builtins ?? builtinProviders()).map((provider) => [provider.id, provider]));
	const result = new Map<string, Provider>();
	for (const entry of config.providers) {
		if (entry.kind === "builtin" && !native.has(entry.id)) throw new Error("Unknown built-in Chat provider");
		if (entry.kind === "custom" && native.has(entry.id)) throw new Error("Custom Chat provider ID conflicts with a built-in provider");
		const base = entry.kind === "builtin" ? native.get(entry.id)! : createChatCustomProvider(entry, options.apis);
		result.set(entry.id, overlayChatProvider(base, entry, options.headers?.get(entry.id), options.onRequestAuth));
	}
	return result;
}

export function chatPriceSource(config: ChatProviderConfig | undefined, model: Model<Api>): "catalog" | "override" | "unknown" {
	if (config?.kind === "custom") return config.models.find((entry) => entry.id === model.id)?.cost ? "override" : "unknown";
	if (config?.kind === "builtin" && Object.prototype.hasOwnProperty.call(config.modelOverrides ?? {}, model.id) && config.modelOverrides![model.id]?.cost) return "override";
	return [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every((value) => Number.isFinite(value) && value >= 0) ? "catalog" : "unknown";
}
