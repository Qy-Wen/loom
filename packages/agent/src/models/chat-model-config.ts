import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const CHAT_CONFIG_VERSION = 1;
export const CHAT_APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export const CHAT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const literals = <const T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: "string", enum: values });
const id = Type.String({ minLength: 1, pattern: "^[a-z0-9][a-z0-9._:-]*$" });
const text = Type.String({ minLength: 1 });
const tokens = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const object = <T extends Parameters<typeof Type.Object>[0]>(fields: T) => Type.Object(fields, { additionalProperties: false });
const jsonFields = Type.Record(Type.String(), Type.Unknown());
const rates = { input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }), cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }) };
const cost = object({ ...rates, tiers: Type.Optional(Type.Array(object({ ...rates, inputTokensAbove: tokens }))) });
const generation = object({
	maxTokens: Type.Optional(tokens), temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
	samplingParams: Type.Optional(jsonFields), cacheRetention: Type.Optional(literals(["none", "short", "long"])),
});
const metadata = {
	name: Type.Optional(text), reasoning: Type.Optional(Type.Boolean()),
	input: Type.Optional(Type.Array(literals(["text", "image"]), { minItems: 1, uniqueItems: true })),
	contextWindow: Type.Optional(tokens), maxTokens: Type.Optional(tokens), cost: Type.Optional(cost),
	thinkingLevelMap: Type.Optional(Type.Unsafe<Partial<Record<(typeof CHAT_THINKING_LEVELS)[number], string | null>>>(Type.Partial(Type.Record(literals(CHAT_THINKING_LEVELS), Type.Union([Type.String(), Type.Null()]))))),
	compat: Type.Optional(jsonFields), samplingParams: Type.Optional(jsonFields),
	samplingParamsByThinkingLevel: Type.Optional(Type.Unsafe<Partial<Record<(typeof CHAT_THINKING_LEVELS)[number], Record<string, unknown>>>>(Type.Partial(Type.Record(literals(CHAT_THINKING_LEVELS), jsonFields)))),
	generation: Type.Optional(generation),
};
const customModel = object({ ...metadata, id: text, api: Type.Optional(literals(CHAT_APIS)),
	reasoning: Type.Boolean(), input: Type.Array(literals(["text", "image"]), { minItems: 1, uniqueItems: true }), contextWindow: tokens, maxTokens: tokens,
});
const providerBase = {
	id, name: Type.Optional(text), enabled: Type.Boolean(), baseUrl: Type.Optional(text),
	// Picker visibility is independent of provider authentication and native model metadata.
	modelEnabled: Type.Optional(Type.Record(text, Type.Boolean())),
	// Values are references to encrypted provider secrets, never literal HTTP header values.
	headers: Type.Optional(Type.Record(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }), id)),
	generation: Type.Optional(generation),
};
const provider = Type.Union([
	object({ ...providerBase, kind: Type.Literal("builtin"), modelOverrides: Type.Optional(Type.Record(text, object(metadata))) }),
	object({ ...providerBase, kind: Type.Literal("custom"), baseUrl: text, api: literals(CHAT_APIS), allowUnauthenticated: Type.Optional(Type.Boolean()), models: Type.Array(customModel) }),
]);
export const ChatConfigSchema = object({
	version: Type.Literal(CHAT_CONFIG_VERSION), providers: Type.Array(provider),
	// Last explicit composer selection, preferred when assigning a conversation's first model. Not edited in Settings.
	default: Type.Optional(object({ provider: id, modelId: text, thinkingLevel: literals(CHAT_THINKING_LEVELS) })),
});
export type ChatModelsConfig = Static<typeof ChatConfigSchema>;
export type ChatProviderConfig = ChatModelsConfig["providers"][number];
export type ChatCustomProviderConfig = Extract<ChatProviderConfig, { kind: "custom" }>;
export type ChatCustomModelConfig = ChatCustomProviderConfig["models"][number];
export type ChatSelection = NonNullable<ChatModelsConfig["default"]>;
export type ChatGenerationDefaults = Static<typeof generation>;
export type ChatApi = (typeof CHAT_APIS)[number];
export type ChatThinkingLevel = (typeof CHAT_THINKING_LEVELS)[number];

export function emptyChatConfig(): ChatModelsConfig { return { version: CHAT_CONFIG_VERSION, providers: [] }; }

/** Reject non-JSON input before cloning; error messages never include input values. */
export function assertJson(value: unknown): void {
	const active = new Set<object>();
	const visit = (value: unknown, depth: number): void => {
		if (depth > 64) throw new Error("JSON nesting limit exceeded");
		if (value === null || typeof value === "string" || typeof value === "boolean") return;
		if (typeof value === "number" && Number.isFinite(value)) return;
		if (typeof value !== "object" || value === null || active.has(value)) throw new Error("Invalid JSON value");
		if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Invalid JSON object");
		active.add(value);
		for (const entry of Object.values(value)) visit(entry, depth + 1);
		active.delete(value);
	};
	visit(value, 0);
}

/** Free-form model metadata must not become an alternative plaintext credential store. */
export function assertPublicMetadata(value: unknown): void {
	assertJson(value);
	const forbidden = /^(api[_-]?key|authorization|cookie|headers|env|access[_-]?token|refresh[_-]?token|credential|credentials|password|secret|token)$/i;
	const visit = (value: unknown): void => {
		if (value === null || typeof value !== "object") return;
		for (const [key, entry] of Object.entries(value)) {
			if (forbidden.test(key)) throw new Error("Secrets are not allowed in public model metadata");
			visit(entry);
		}
	};
	visit(value);
}

export function validateChatBaseUrl(value: string): void {
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Invalid Chat base URL"); }
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Chat base URL must be HTTP(S) without credentials, query, or fragment");
}

export function parseChatConfig(value: unknown): ChatModelsConfig {
	assertJson(value);
	if (!Value.Check(ChatConfigSchema, value)) throw new Error("Invalid or unsupported Chat configuration");
	const config = structuredClone(value) as ChatModelsConfig;
	const ids = new Set<string>();
	for (const provider of config.providers) {
		if (ids.has(provider.id)) throw new Error("Duplicate Chat provider ID");
		ids.add(provider.id);
		if (provider.baseUrl !== undefined) validateChatBaseUrl(provider.baseUrl);
		if (provider.headers && new Set(Object.keys(provider.headers).map((key) => key.toLowerCase())).size !== Object.keys(provider.headers).length) throw new Error("Duplicate Chat header name");
		if (provider.generation !== undefined) assertPublicMetadata(provider.generation);
		const models = provider.kind === "custom" ? provider.models : Object.values(provider.modelOverrides ?? {});
		const modelIds = new Set<string>();
		for (const model of models) {
			assertPublicMetadata(model);
			if ("id" in model && typeof model.id === "string") {
				if (model.id.trim() !== model.id || modelIds.has(model.id)) throw new Error("Invalid or duplicate Chat model ID");
				modelIds.add(model.id);
			}
			if (model.input && !model.input.includes("text")) throw new Error("Chat models must accept text input");
		}
	}
	if (config.default) {
		const selected = config.providers.find((provider) => provider.id === config.default!.provider);
		if (!selected) throw new Error("Default Chat provider is not configured");
		if (config.default.modelId.trim() !== config.default.modelId) throw new Error("Invalid default Chat model ID");
		if (selected.kind === "custom" && !selected.models.some((model) => model.id === config.default!.modelId)) throw new Error("Default custom Chat model is not configured");
	}
	return config;
}
