import {
	parseChatConfig, validateChatBaseUrl,
	type ChatApi, type ChatCustomModelConfig, type ChatCustomProviderConfig, type ChatModelsConfig,
} from "@loom/agent/chat-models";
import { chatEndpointUrl, ChatEndpointError, parseChatEndpoint } from "../../shared/chat-endpoint.ts";

export type CustomModelDraft = {
	key: number;
	original?: ChatCustomModelConfig;
	id: string;
	name: string;
	contextWindow: string;
	maxTokens: string;
	reasoning: boolean;
	image: boolean;
};
export type CustomProviderDraft = { name: string; requestUrl: string; manualApi?: ChatApi; models: CustomModelDraft[] };
export type CustomDraftErrorCode = "baseUrl" | "protocol" | "query" | "modelIds" | "tokenLimits" | "noModels";
export class CustomDraftError extends Error {
	readonly code: CustomDraftErrorCode;
	constructor(code: CustomDraftErrorCode) { super(code); this.code = code; }
}

export function customModelDraft(key: number, model?: ChatCustomModelConfig): CustomModelDraft {
	return {
		key, ...(model ? { original: structuredClone(model) } : {}),
		id: model?.id ?? "", name: model?.name ?? "",
		contextWindow: String(model?.contextWindow ?? 128_000), maxTokens: String(model?.maxTokens ?? 8192),
		reasoning: model?.reasoning ?? false, image: model?.input.includes("image") ?? false,
	};
}
export function customProviderDraft(provider?: ChatCustomProviderConfig): CustomProviderDraft {
	return {
		name: provider?.name ?? "", requestUrl: provider ? chatEndpointUrl(provider.baseUrl, provider.api, provider.models[0]?.id) : "",
		models: provider ? provider.models.map((model, index) => customModelDraft(index, model)) : [customModelDraft(0)],
	};
}

/** Edit exposed fields only: preserve stable provider identity, secret references and advanced metadata. */
export function buildCustomProvider(id: string, draft: CustomProviderDraft, original?: ChatCustomProviderConfig): ChatCustomProviderConfig {
	let baseUrl: string, api: ChatApi;
	try {
		if (draft.manualApi) {
			baseUrl = draft.requestUrl.trim(); api = draft.manualApi;
			validateChatBaseUrl(baseUrl);
		} else ({ baseUrl, api } = parseChatEndpoint(draft.requestUrl));
	} catch (cause) {
		throw new CustomDraftError(cause instanceof ChatEndpointError && cause.code !== "url" ? cause.code : "baseUrl");
	}
	if (!draft.models.length) throw new CustomDraftError("noModels");
	const ids = new Set<string>();
	const models = draft.models.map((row): ChatCustomModelConfig => {
		const modelId = row.id.trim();
		if (!modelId || ids.has(modelId)) throw new CustomDraftError("modelIds");
		ids.add(modelId);
		const contextWindow = Number(row.contextWindow), maxTokens = Number(row.maxTokens);
		if (![contextWindow, maxTokens].every((value) => Number.isSafeInteger(value) && value > 0)) throw new CustomDraftError("tokenLimits");
		const model: ChatCustomModelConfig = {
			...row.original, id: modelId, reasoning: row.reasoning,
			input: row.image ? ["text", "image"] : ["text"], contextWindow, maxTokens,
		};
		if (row.name.trim()) model.name = row.name.trim(); else delete model.name;
		return model;
	});
	const provider: ChatCustomProviderConfig = {
		...original, kind: "custom", id, enabled: original?.enabled ?? true, baseUrl, api, models,
	};
	if (draft.name.trim()) provider.name = draft.name.trim(); else delete provider.name;
	if (original?.modelEnabled) {
		const modelEnabled = { ...original.modelEnabled };
		for (const model of original.models) delete modelEnabled[model.id];
		for (const row of draft.models) {
			if (row.original && Object.hasOwn(original.modelEnabled, row.original.id)) modelEnabled[row.id.trim()] = original.modelEnabled[row.original.id]!;
		}
		provider.modelEnabled = modelEnabled;
	}
	return parseChatConfig({ version: 1, providers: [provider] }).providers[0] as ChatCustomProviderConfig;
}

export function putCustomProvider(config: ChatModelsConfig, provider: ChatCustomProviderConfig): ChatModelsConfig {
	const next = structuredClone(config);
	const index = next.providers.findIndex((entry) => entry.id === provider.id);
	if (index < 0) next.providers.push(provider); else next.providers[index] = provider;
	// Missing/renamed model IDs do not rewrite saved conversations or select a replacement.
	if (next.default?.provider === provider.id && !provider.models.some((model) => model.id === next.default!.modelId)) delete next.default;
	return parseChatConfig(next);
}
