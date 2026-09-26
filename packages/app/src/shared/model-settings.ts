export const MODEL_SLOTS = ["chat", "embedding", "rerank", "vlm", "audio"] as const;

export type ModelSlotId = (typeof MODEL_SLOTS)[number];

export interface ModelSlotRecord {
	baseUrl: string;
	apiKey: string;
	model: string;
	enabled: boolean;
}

export type ModelSettingsFile = Record<ModelSlotId, ModelSlotRecord>;

export interface ModelSlotView {
	baseUrl: string;
	model: string;
	apiKey: string;
	enabled: boolean;
}

export type ModelSettingsView = Record<ModelSlotId, ModelSlotView>;

export interface ModelSlotDraft {
	baseUrl: string;
	model: string;
	enabled: boolean;
	/** Set only when the user typed a new key. Omit to keep the stored key. */
	apiKey?: string;
	clearApiKey?: boolean;
}

export type ModelSettingsDraft = Record<ModelSlotId, ModelSlotDraft>;

export type ModelProbeDraft = {
	slot: ModelSlotId;
	baseUrl: string;
	model: string;
	apiKey?: string;
};

export type ProbeResult = {
	ok: boolean;
	error?: string;
};

export function emptySettingsFile(): ModelSettingsFile {
	const empty = { baseUrl: "", apiKey: "", model: "", enabled: false };
	const next = {} as ModelSettingsFile;
	for (const id of MODEL_SLOTS) next[id] = { ...empty };
	return next;
}
