import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { modelRequestUrl } from "../../shared/model-request-url.ts";
import {
	MODEL_SLOTS,
	type ModelSettingsDraft,
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

export function applySlotDraft(current: ModelSlotRecord, draft: ModelSettingsDraft[ModelSlotId]): ModelSlotRecord {
	const next = {
		requestUrl: draft.requestUrl.trim() ? modelRequestUrl(draft.requestUrl) : "",
		model: draft.model.trim(),
		apiKey: current.apiKey,
		enabled: draft.enabled,
	};
	if (draft.clearApiKey) next.apiKey = "";
	else if (draft.apiKey !== undefined) next.apiKey = draft.apiKey;
	return next;
}

export function applySettingsDraft(current: ModelSettingsFile, draft: ModelSettingsDraft): ModelSettingsFile {
	const next = emptySettingsFile();
	for (const id of MODEL_SLOTS) next[id] = applySlotDraft(current[id], draft[id]);
	return next;
}

export class ModelSettingsStore {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<ModelSettingsFile> {
		try {
			return parseSettingsFile(JSON.parse(await readFile(this.filePath, "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySettingsFile();
			throw error;
		}
	}

	async save(file: ModelSettingsFile): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	}

	async update(draft: ModelSettingsDraft): Promise<ModelSettingsFile> {
		const next = applySettingsDraft(await this.load(), draft);
		await this.save(next);
		return next;
	}

	async view(): Promise<ModelSettingsView> {
		return settingsView(await this.load());
	}
}
