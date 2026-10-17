import { ChatConfigSchema, emptyChatConfig, parseChatConfig, type ChatCustomProviderConfig, type ChatModelsConfig, type ChatProviderConfig } from "@loom/agent/chat-models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { chatEndpointUrl, parseChatEndpoint } from "../shared/chat-endpoint.ts";
import type { ChatModelService } from "./chat-model-service.ts";

type ProviderFields = Omit<ChatCustomProviderConfig, "id" | "kind"> & Pick<Extract<ChatProviderConfig, { kind: "builtin" }>, "modelOverrides">;
export type ChatProviderPatch = Partial<ProviderFields> & {
	id: string;
	kind?: "builtin" | "custom";
	requestUrl?: string;
	apiKey?: string;
	clearApiKey?: true;
};
export type ChatSettingsPatch = { upsert?: ChatProviderPatch[]; remove?: string[]; refresh?: boolean };

export function chatSettingsPatchSchema(): Record<string, unknown> {
	const configSchema = ChatConfigSchema as unknown as { properties: { providers: { items: { anyOf: Array<{ properties: Record<string, unknown> }> } } } };
	const [builtin, custom] = configSchema.properties.providers.items.anyOf;
	return {
		type: "object", additionalProperties: false,
		properties: {
			upsert: { type: "array", items: {
				type: "object", required: ["id"], additionalProperties: false,
				properties: {
					...builtin!.properties, ...custom!.properties,
					kind: { type: "string", enum: ["builtin", "custom"] },
					requestUrl: { type: "string", description: "Custom providers only: complete standard Chat endpoint URL; infers api and baseUrl. Use this OR baseUrl + api. Built-in providers retain native protocols and accept baseUrl overrides." },
					apiKey: { type: "string", description: "Write-only API key, stored encrypted. The argument remains in this conversation; prefer the Settings key dialog." },
					clearApiKey: { type: "boolean", const: true, description: "Remove only the stored API-key credential, not OAuth or environmental keys." },
				},
			} },
			remove: { type: "array", items: { type: "string" }, description: "Remove configured providers; credentials remain encrypted for re-adding." },
			refresh: { type: "boolean", description: "Refresh supported native catalogs; not a connection test." },
		},
	};
}

export function parseChatSettingsPatch(value: unknown): ChatSettingsPatch {
	const record = object(value);
	assertFields(record, ["upsert", "remove", "refresh"]);
	const patch: ChatSettingsPatch = {};
	if (record.remove !== undefined) {
		if (!Array.isArray(record.remove) || record.remove.some((id) => typeof id !== "string" || !id.trim())) throw new Error("chat.remove must contain provider IDs");
		patch.remove = record.remove;
	}
	if (record.refresh !== undefined) {
		if (typeof record.refresh !== "boolean") throw new Error("chat.refresh must be boolean");
		patch.refresh = record.refresh;
	}
	if (record.upsert !== undefined) {
		if (!Array.isArray(record.upsert)) throw new Error("chat.upsert must be a provider list");
		const seen = new Set<string>();
		patch.upsert = record.upsert.map((raw) => {
			const row = object(raw);
			assertFields(row, ["id", "kind", "name", "enabled", "baseUrl", "api", "models", "modelEnabled", "modelOverrides", "generation", "headers", "allowUnauthenticated", "requestUrl", "apiKey", "clearApiKey"]);
			if (typeof row.id !== "string" || !row.id.trim() || seen.has(row.id)) throw new Error("chat.upsert needs unique provider IDs");
			seen.add(row.id);
			if (row.apiKey !== undefined && (typeof row.apiKey !== "string" || !row.apiKey.trim())) throw new Error("Chat apiKey must be non-empty text");
			if (row.clearApiKey !== undefined && row.clearApiKey !== true) throw new Error("Chat clearApiKey must be true");
			if (row.apiKey !== undefined && row.clearApiKey) throw new Error("Cannot set and clear a Chat key together");
			if (row.requestUrl !== undefined && (typeof row.requestUrl !== "string" || row.baseUrl !== undefined || row.api !== undefined)) throw new Error("Use requestUrl OR baseUrl + api");
			return { ...row } as ChatProviderPatch;
		});
	}
	if (!patch.upsert?.length && !patch.remove?.length && !patch.refresh) throw new Error("chat needs a provider change or refresh");
	if (patch.upsert?.some((row) => patch.remove?.includes(row.id))) throw new Error("Cannot upsert and remove the same Chat provider");
	return patch;
}

export function chatConfigForPatch(current: ChatModelsConfig, patch: ChatSettingsPatch): ChatModelsConfig {
	const next = structuredClone(current);
	next.providers = next.providers.filter((row) => !patch.remove?.includes(row.id));
	for (const update of patch.upsert ?? []) {
		const { apiKey: _key, clearApiKey: _clear, requestUrl, ...fields } = update;
		const index = next.providers.findIndex((row) => row.id === update.id);
		const existing = index < 0 ? undefined : next.providers[index];
		if (existing && fields.kind && existing.kind !== fields.kind) throw new Error("Cannot change a Chat provider's kind");
		if (requestUrl !== undefined && (existing?.kind ?? fields.kind ?? "builtin") !== "custom") throw new Error("requestUrl is only for custom Chat providers; built-ins accept baseUrl and retain native protocols");
		const endpoint = requestUrl === undefined ? undefined : parseChatEndpoint(requestUrl);
		const merged = {
			...(existing ?? { id: fields.id, kind: fields.kind ?? "builtin", enabled: true }), ...fields,
			...(endpoint ? { baseUrl: endpoint.baseUrl, api: endpoint.api } : {}),
			...(fields.modelEnabled ? { modelEnabled: { ...existing?.modelEnabled, ...fields.modelEnabled } } : {}),
		};
		const provider = parseChatConfig({ ...emptyChatConfig(), providers: [merged] }).providers[0]!;
		if (index < 0) next.providers.push(provider); else next.providers[index] = provider;
	}
	if (next.default) {
		const provider = next.providers.find((row) => row.id === next.default!.provider);
		if (!provider || (provider.kind === "custom" && !provider.models.some((row) => row.id === next.default!.modelId))) delete next.default;
	}
	return parseChatConfig(next);
}

/** Public tool projection: metadata and opt-in catalogs, never auth values or header references. */
export async function publicChatSettings(service: ChatModelService, providerId?: string) {
	const [view, credentials] = await Promise.all([service.view(), service.stores.credentials.list()]);
	return {
		providers: view.config.providers.map(({ headers, ...provider }) => ({
			...provider, hasHeaders: !!headers && Object.keys(headers).length > 0,
			...(provider.kind === "custom" ? { requestUrl: chatEndpointUrl(provider.baseUrl, provider.api, provider.models[0]?.id) } : {}),
			auth: view.auth.find((row) => row.providerId === provider.id),
			hasApiKey: credentials.some((row) => row.providerId === provider.id && row.type === "api_key") || view.auth.some((row) => row.providerId === provider.id && row.configured && row.type === "api_key" && row.source !== "no authentication"),
		})),
		models: view.models.filter((model) => model.provider === providerId),
		catalog: builtinProviders().filter((provider) => provider.getModels().length).map((provider) => ({
			id: provider.id, name: provider.name, apiKeyAuth: !!provider.auth.apiKey, oauthAuth: !!provider.auth.oauth,
			modelCount: provider.getModels().length,
		})),
		refreshErrors: view.refreshErrors,
	};
}

export async function applyChatSettingsPatch(service: ChatModelService, patch: ChatSettingsPatch): Promise<string[]> {
	const next = chatConfigForPatch(service.config, patch);
	const apiKeys = (patch.upsert ?? []).flatMap<{ providerId: string; key: string | null }>((row) => row.apiKey !== undefined ? [{ providerId: row.id, key: row.apiKey }]
		: row.clearApiKey ? [{ providerId: row.id, key: null }] : []);
	await service.save(next, apiKeys);
	if (patch.refresh) await service.refresh({ allowNetwork: true });
	return ["Chat provider/model settings saved. Existing conversations keep their model/thinking; choose conversation models in the composer. OAuth login remains in Settings."];
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Chat settings patch");
	return value as Record<string, unknown>;
}
function assertFields(record: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Unknown Chat settings field");
}
