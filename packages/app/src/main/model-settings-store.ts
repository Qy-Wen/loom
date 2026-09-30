import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LoomChatEndpoint } from "@loom/agent";
import {
	MODEL_SLOTS,
	type ModelSettingsDraft,
	type ModelSettingsFile,
	type ModelSettingsView,
	type ModelSlotDraft,
	type ModelSlotRecord,
	type ModelSlotView,
	emptySettingsFile,
} from "../shared/model-settings.ts";

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com";
const DEEPSEEK_CHAT_MODEL = "deepseek-v4-flash";

export function emptySlot(): ModelSlotRecord {
	return { baseUrl: "", apiKey: "", model: "", enabled: false };
}

function asRecord(value: unknown): ModelSlotRecord {
	if (!value || typeof value !== "object") return emptySlot();
	const row = value as Partial<ModelSlotRecord>;
	const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl : "";
	const apiKey = typeof row.apiKey === "string" ? row.apiKey : "";
	const model = typeof row.model === "string" ? row.model : "";
	const contextWindow = typeof row.contextWindow === "number" && Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0
		? row.contextWindow
		: undefined;
	return {
		baseUrl,
		apiKey,
		model,
		enabled: typeof row.enabled === "boolean" ? row.enabled : Boolean(baseUrl.trim() && model.trim()),
		...(contextWindow !== undefined ? { contextWindow } : {}),
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
		baseUrl: slot.baseUrl,
		model: slot.model,
		apiKey: slot.apiKey,
		enabled: slot.enabled,
		...(slot.contextWindow !== undefined ? { contextWindow: slot.contextWindow } : {}),
	};
}

export function settingsView(file: ModelSettingsFile): ModelSettingsView {
	const next = {} as ModelSettingsView;
	for (const id of MODEL_SLOTS) next[id] = slotView(file[id]);
	return next;
}

export function applySlotDraft(current: ModelSlotRecord, draft: ModelSlotDraft): ModelSlotRecord {
	const contextWindow = typeof draft.contextWindow === "number" && Number.isSafeInteger(draft.contextWindow) && draft.contextWindow > 0
		? draft.contextWindow
		: undefined;
	const next = {
		baseUrl: draft.baseUrl.trim(),
		model: draft.model.trim(),
		apiKey: current.apiKey,
		enabled: draft.enabled,
		...(contextWindow !== undefined ? { contextWindow } : {}),
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

/** First save of the .env Chat prefill must persist the key, not only URL + model. */
export function copyBootstrapChatKey(
	next: ModelSettingsFile,
	draft: ModelSettingsDraft,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (draft.chat.clearApiKey || draft.chat.apiKey !== undefined) return;
	if (next.chat.apiKey.trim()) return;
	const boot = resolveChatEndpoint(emptySettingsFile(), env, true);
	if (!boot?.apiKey) return;
	if (next.chat.baseUrl !== boot.baseUrl || next.chat.model !== boot.model) return;
	next.chat.apiKey = boot.apiKey;
}

/** Chat from saved settings, or DeepSeek env only before the user has saved Settings. */
export function resolveChatEndpoint(
	file: ModelSettingsFile,
	env: NodeJS.ProcessEnv = process.env,
	allowEnvBootstrap = true,
): LoomChatEndpoint | undefined {
	const saved = file.chat;
	if (saved.baseUrl.trim() && saved.model.trim()) {
		if (!saved.enabled) return undefined;
		return {
			baseUrl: saved.baseUrl.trim(),
			model: saved.model.trim(),
			apiKey: saved.apiKey.trim() || undefined,
			...(saved.contextWindow !== undefined ? { contextWindow: saved.contextWindow } : {}),
		};
	}
	if (!allowEnvBootstrap) return undefined;
	const bootstrap = env.DEEPSEEK_API_KEY?.trim();
	if (!bootstrap) return undefined;
	return {
		baseUrl: DEEPSEEK_CHAT_URL,
		model: DEEPSEEK_CHAT_MODEL,
		apiKey: bootstrap,
	};
}

export function bootstrapChatView(
	file: ModelSettingsFile,
	env: NodeJS.ProcessEnv = process.env,
	allowEnvBootstrap = true,
): ModelSlotView {
	const chat = resolveChatEndpoint(file, env, allowEnvBootstrap);
	if (!chat) return slotView(file.chat);
	if (file.chat.baseUrl.trim() && file.chat.model.trim()) return slotView(file.chat);
	return { baseUrl: chat.baseUrl, model: chat.model, apiKey: chat.apiKey ?? "", enabled: true };
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

	async update(draft: ModelSettingsDraft, env: NodeJS.ProcessEnv = process.env): Promise<ModelSettingsFile> {
		const existed = this.exists();
		const next = applySettingsDraft(await this.load(), draft);
		if (!existed) copyBootstrapChatKey(next, draft, env);
		await this.save(next);
		return next;
	}

	exists(): boolean {
		return existsSync(this.filePath);
	}

	async view(env: NodeJS.ProcessEnv = process.env): Promise<ModelSettingsView> {
		const file = await this.load();
		const view = settingsView(file);
		view.chat = bootstrapChatView(file, env, !this.exists());
		return view;
	}

	async chat(env: NodeJS.ProcessEnv = process.env): Promise<LoomChatEndpoint | undefined> {
		return resolveChatEndpoint(await this.load(), env, !this.exists());
	}
}
