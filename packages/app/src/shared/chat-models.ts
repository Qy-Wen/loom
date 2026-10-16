export type { ChatModelsConfig, ChatProviderConfig, ChatCustomProviderConfig, ChatCustomModelConfig, ChatSelection, ChatGenerationDefaults, ChatApi, ChatThinkingLevel } from "@loom/agent/chat-models";

/** Ordinary IPC reads never carry credentials or resolved header values. */
export type ChatAuthStatus = {
	providerId: string;
	configured: boolean;
	type?: "api_key" | "oauth";
	source?: string;
	error?: string;
};

export type ChatModelView = {
	provider: string;
	id: string;
	name: string;
	api: string;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	thinkingLevels: import("@loom/agent/chat-models").ChatThinkingLevel[];
	priceSource: "catalog" | "override" | "unknown";
	/** Missing means unknown; never expose pi-ai's zero/negative unknown-price placeholders as rates. */
	cost?: import("@loom/agent/chat-models").ChatCustomModelConfig["cost"];
	available: boolean;
};
