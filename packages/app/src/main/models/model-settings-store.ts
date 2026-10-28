import { JsonFile, logStorage, readOptionalFile } from "../storage/file.ts";
import type { ChatSecretCipher } from "./chat-credential-store.ts";
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

/**
 * Read one stored key. A file written before keys were encrypted holds `apiKey` in plain text; that is still
 * read, and `ModelSettingsStore.protect` rewrites it. A key that cannot be decrypted (a file copied from another
 * computer or account, or a reset keychain) reads as empty so the rest of the settings still load.
 */
function storedKey(row: { apiKey?: unknown; apiKeyEncrypted?: unknown }, decrypt: ((value: Buffer) => string) | undefined): string {
	if (typeof row.apiKeyEncrypted === "string" && row.apiKeyEncrypted) {
		try { return decrypt ? decrypt(Buffer.from(row.apiKeyEncrypted, "base64")) : ""; }
		catch { logStorage("A model API key could not be decrypted and was dropped; enter it again in Settings."); return ""; }
	}
	return typeof row.apiKey === "string" ? row.apiKey : "";
}

function asRecord(value: unknown, decrypt?: (value: Buffer) => string): ModelSlotRecord {
	if (!value || typeof value !== "object") return emptySlot();
	const row = value as Partial<ModelSlotRecord> & { apiKeyEncrypted?: unknown };
	return {
		requestUrl: typeof row.requestUrl === "string" ? row.requestUrl : "",
		apiKey: storedKey(row, decrypt),
		model: typeof row.model === "string" ? row.model : "",
		enabled: row.enabled === true,
	};
}

export function parseSettingsFile(value: unknown, decrypt?: (value: Buffer) => string): ModelSettingsFile {
	const raw = value && typeof value === "object" ? value as Partial<ModelSettingsFile> : {};
	const next = emptySettingsFile();
	for (const id of MODEL_SLOTS) next[id] = asRecord(raw[id], decrypt);
	return next;
}

/** The on-disk shape: the key is encrypted and never written as `apiKey`. */
function serializeSettings(file: ModelSettingsFile, cipher: ChatSecretCipher): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const id of MODEL_SLOTS) {
		const { apiKey, ...rest } = file[id];
		if (apiKey && !cipher.available()) throw new Error("API keys cannot be saved: encryption is unavailable on this computer, and plain-text storage is disabled.");
		out[id] = apiKey ? { ...rest, apiKeyEncrypted: cipher.encrypt(apiKey).toString("base64") } : rest;
	}
	return out;
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

function plainTextKeyIn(text: string | undefined): boolean {
	if (text === undefined) return false;
	try {
		const raw = JSON.parse(text) as Record<string, { apiKey?: unknown } | undefined>;
		return MODEL_SLOTS.some((id) => typeof raw[id]?.apiKey === "string" && raw[id]!.apiKey !== "");
	} catch { return false; }
}

export class ModelSettingsStore {
	private readonly file: JsonFile<ModelSettingsFile>;
	private readonly cipher: ChatSecretCipher;

	/** Keys are encrypted with `cipher` on disk. The cipher is required so no caller can store them in plain text by omission. */
	constructor(filePath: string, cipher: ChatSecretCipher) {
		this.cipher = cipher;
		this.file = new JsonFile(
			filePath,
			(value) => parseSettingsFile(value, (data) => cipher.decrypt(data)),
			{ recoverCorrupt: true, serialize: (value) => serializeSettings(value, cipher) },
		);
	}

	/**
	 * Re-save a file that still holds a plain-text key so it is encrypted at rest. Safe to call on every start:
	 * it does nothing when no plain-text key is present, or when encryption is unavailable (the key is then left
	 * as it was rather than lost).
	 */
	async protect(): Promise<boolean> {
		if (!this.cipher.available()) return false;
		return this.file.update(async (current) => {
			if (!current || !plainTextKeyIn(await readOptionalFile(this.file.path))) return { result: false };
			return { value: current, result: true };
		});
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
