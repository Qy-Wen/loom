import { createModels, type Models, type MutableModels } from "@earendil-works/pi-ai/models";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createChatCustomProvider } from "@loom/agent/chat-runtime";

/** Test-only: an app-shaped injected runtime around one OpenAI-compatible endpoint. */
export async function testChatRuntime(baseUrl: string, options: { apiKey?: string; model?: string; contextWindow?: number; providerId?: string; models?: Models } = {}): Promise<{
	models: Models;
	providerId: string;
	modelId: string;
}> {
	const providerId = options.providerId ?? "test-chat";
	const modelId = options.model ?? "demo";
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({ type: "api_key", key: options.apiKey ?? "test" }));
	const models: MutableModels = options.models as MutableModels ?? createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
	const provider = createChatCustomProvider({
		id: providerId, kind: "custom", enabled: true, baseUrl,
		api: "openai-completions",
		models: [{ id: modelId, reasoning: false, input: ["text", "image"], contextWindow: options.contextWindow ?? 128_000, maxTokens: 8192 }],
	});
	models.setProvider(provider);
	return { models, providerId, modelId };
}
