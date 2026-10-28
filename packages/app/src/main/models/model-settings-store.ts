import { JsonFile } from "../storage/file.ts";
import { modelRequestUrl } from "../../shared/model-request-url.ts";
import {
	MODEL_SLOTS,
	type ModelSettingsPatch,
	type ModelSlotId,
	type ModelSettingsFile,
	type ModelSettingsView,
	type ModelSlotRecord,
	type ModelSlotView,
	emptySettingsFile,
} from "../../shared/model-settings.ts";

export function emptySlot(): ModelSlotRecord {
	return { requestUrl: "", apiKey: "", model: "", enabled: false };
}

function asRecord(value: unknown): ModelSlotRecord {
	if (!value || typeof value !== "object") return emptySlot();
	const row = value as Partial<ModelSlotRecord>;
	return {
		requestUrl: typeof row.requestUrl === "string" ? row.requestUrl : "",
		apiKey: typeof row.apiKey === "string" ? row.apiKey : "",
		model: typeof row.model === "string" ? row.model : "",
		enabled: row.enabled === true,
	};
}

export function parseSettingsFile(value: unknown): ModelSettingsFile {
	const raw = value && typeof value === "object" ? value as Partial<ModelSettingsFile> : {};
	const next = emptySettingsFile();
	for (const id of MODEL_SLOTS) next[id] = asRecord(raw[id]);
	return next;
}

export function slotView(slot: ModelSlotRecord): ModelSlotView {
	return {
		requestUrl: slot.requestUrl,
		model: slot.model,
		apiKey: slot.apiKey,
		enabled: slot.enabled,
	};
}

export function settingsView(file: ModelSettingsFile): ModelSettingsView {
	const next = {} as ModelSettingsView;
	for (const id of MODEL_SLOTS) next[id] = slotView(file[id]);
	return next;
}

function applySlotPatch(current: ModelSlotRecord, draft: NonNullable<ModelSettingsPatch[ModelSlotId]>): ModelSlotRecord {
	const next = {
		requestUrl: draft.requestUrl === undefined ? current.requestUrl : (draft.requestUrl.trim() ? modelRequestUrl(draft.requestUrl) : ""),
		model: draft.model?.trim() ?? current.model,
		apiKey: current.apiKey,
		enabled: draft.enabled ?? current.enabled,
	};
	if (draft.clearApiKey && draft.apiKey !== undefined) throw new Error("A slot cannot set and clear its API key in one change.");
	if (draft.clearApiKey) next.apiKey = "";
	else if (draft.apiKey !== undefined) next.apiKey = draft.apiKey;
	return next;
}

export function applyModelSettingsPatch(current: ModelSettingsFile, draft: ModelSettingsPatch): ModelSettingsFile {
	const next = emptySettingsFile();
	for (const id of MODEL_SLOTS) next[id] = draft[id] ? applySlotPatch(current[id], draft[id]) : { ...current[id] };
	return next;
}

export class ModelSettingsStore {
	private readonly file: JsonFile<ModelSettingsFile>;

	constructor(filePath: string) {
		this.file = new JsonFile(filePath, parseSettingsFile, { recoverCorrupt: true });
	}

	async load(): Promise<ModelSettingsFile> {
		return await this.file.read() ?? emptySettingsFile();
	}

	async update(patch: ModelSettingsPatch): Promise<ModelSettingsFile> {
		return this.file.update(async (current) => {
			const next = applyModelSettingsPatch(current ?? emptySettingsFile(), patch);
			return { value: next, result: next };
		});
	}

	async view(): Promise<ModelSettingsView> {
		return settingsView(await this.load());
	}
}
