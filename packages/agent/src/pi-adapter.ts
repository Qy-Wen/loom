import { convertToLlm, type AgentMessage } from "#vendor/pi-agent";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { foldUserMessageForLlm } from "./attachments.ts";
import type { LoomChatEndpoint } from "./types.ts";

const CHAT_PROVIDER = "loom-chat";

export function chatEndpointReady(chat: LoomChatEndpoint | undefined): chat is LoomChatEndpoint {
	return Boolean(chat?.baseUrl.trim() && chat.model.trim());
}

/** Build the current Chat model for the durable Harness runtime. */
export function buildChatModels(chat: LoomChatEndpoint) {
	const baseUrl = chat.baseUrl.trim().replace(/\/+$/, "");
	const modelId = chat.model.trim();
	const apiKey = chat.apiKey?.trim();
	const models = createModels();
	models.setProvider(createProvider({
		id: CHAT_PROVIDER,
		name: "Loom Chat",
		baseUrl,
		auth: {
			apiKey: {
				name: "Chat API key",
				async resolve() {
					return { auth: apiKey ? { apiKey } : {}, source: apiKey ? "settings" : "none" };
				},
			},
		},
		models: [{
			id: modelId,
			name: modelId,
			api: "openai-completions",
			provider: CHAT_PROVIDER,
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8192,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens",
			},
		}],
		api: openAICompletionsApi(),
	}));
	const model = models.getModel(CHAT_PROVIDER, modelId);
	if (!model) throw new Error(`Unknown model: ${modelId}`);
	return { models, model };
}

/** Keep Loom attachment sidecars on disk; fold them only for Chat requests. */
export function toProviderMessages(messages: AgentMessage[]) {
	return convertToLlm(messages.map((message) => foldUserMessageForLlm(message)));
}
