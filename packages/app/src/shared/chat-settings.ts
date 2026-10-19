import type { ChatCustomProviderConfig, ChatProviderConfig } from "@loom/agent/chat-models";

type ProviderFields = Omit<ChatCustomProviderConfig, "id" | "kind"> & Pick<Extract<ChatProviderConfig, { kind: "builtin" }>, "modelOverrides">;
export type ChatProviderPatch = Partial<ProviderFields> & {
	id: string;
	kind?: "builtin" | "custom";
	requestUrl?: string;
	apiKey?: string;
	clearApiKey?: true;
	clearName?: true;
};
export type ChatSettingsPatch = { upsert?: ChatProviderPatch[]; remove?: string[]; refresh?: boolean };
