export const MODEL_SLOTS = ["chat", "embedding", "rerank", "vlm"] as const;

export type ModelSlotId = (typeof MODEL_SLOTS)[number];

export interface ModelSlotRecord {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export type ModelSettingsFile = Record<ModelSlotId, ModelSlotRecord>;

export interface ModelSlotView {
	baseUrl: string;
	model: string;
	apiKey: string;
}

export type ModelSettingsView = Record<ModelSlotId, ModelSlotView>;

export interface ModelSlotDraft {
	baseUrl: string;
	model: string;
	/** Set only when the user typed a new key. Omit to keep the stored key. */
	apiKey?: string;
	clearApiKey?: boolean;
}

export type ModelSettingsDraft = Record<ModelSlotId, ModelSlotDraft>;

export function emptySettingsFile(): ModelSettingsFile {
	const empty = { baseUrl: "", apiKey: "", model: "" };
	return {
		chat: { ...empty },
		embedding: { ...empty },
		rerank: { ...empty },
		vlm: { ...empty },
	};
}
