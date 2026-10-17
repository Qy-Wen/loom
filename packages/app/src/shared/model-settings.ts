export const MODEL_SLOTS = ["embedding", "rerank", "vlm", "audio"] as const;

export type ModelSlotId = (typeof MODEL_SLOTS)[number];

export const MODEL_REQUEST_PLACEHOLDERS: Record<ModelSlotId, string> = {
	embedding: "https://api.example.com/v1/embeddings",
	rerank: "https://qianfan.baidubce.com/v2/rerank",
	vlm: "https://api.example.com/v1/chat/completions",
	audio: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
};

export interface ModelSlotRecord {
	/** Exact HTTP(S) request URL, including the operation path and optional query parameters. */
	requestUrl: string;
	apiKey: string;
	model: string;
	enabled: boolean;
}

export type ModelSettingsFile = Record<ModelSlotId, ModelSlotRecord>;

export interface ModelSlotView {
	requestUrl: string;
	model: string;
	apiKey: string;
	enabled: boolean;
}

export type ModelSettingsView = Record<ModelSlotId, ModelSlotView>;

export interface ModelSlotDraft {
	/** Exact request URL, including the operation path and any query parameters. */
	requestUrl: string;
	model: string;
	enabled: boolean;
	/** Set only when the user typed a new key. Omit to keep the stored key. */
	apiKey?: string;
	clearApiKey?: boolean;
}

export type ModelSettingsDraft = Record<ModelSlotId, ModelSlotDraft>;

export type ModelProbeDraft = {
	slot: ModelSlotId;
	requestUrl: string;
	model: string;
	apiKey?: string;
};

export type ProbeResult = {
	ok: boolean;
	error?: string;
};

export function emptySettingsFile(): ModelSettingsFile {
	const empty = { requestUrl: "", apiKey: "", model: "", enabled: false };
	const next = {} as ModelSettingsFile;
	for (const id of MODEL_SLOTS) next[id] = { ...empty };
	return next;
}
