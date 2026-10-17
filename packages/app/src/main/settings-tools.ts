import type { LoomTool } from "@loom/agent";
import { APP_LANGUAGE_CHOICES, type AppLanguageChoice } from "../shared/general-settings.ts";
import { chatSettingsPatchSchema, parseChatSettingsPatch, type ChatSettingsPatch, type publicChatSettings } from "./chat-settings-tools.ts";
import { emptyMcpServerDraft, envToText, linesOf, type McpServerDraft } from "../shared/mcp-settings.ts";
import {
	MODEL_SLOTS,
	type ModelSettingsDraft,
	type ModelSettingsFile,
	type ModelSlotDraft,
	type ModelSlotId,
	type ModelSlotRecord,
} from "../shared/model-settings.ts";

export interface PublicModelSlot {
	requestUrl: string;
	model: string;
	enabled: boolean;
	hasApiKey: boolean;
}

export interface PublicMcpServer {
	id: string;
	transport: "stdio" | "http";
	enabled: boolean;
	command: string;
	args: string[];
	url: string;
	cwd: string;
	hasEnv: boolean;
	hasHeaders: boolean;
}

export interface PublicSettings {
	language: AppLanguageChoice;
	chat: Awaited<ReturnType<typeof publicChatSettings>>;
	models: Record<ModelSlotId, PublicModelSlot>;
	sandbox: boolean;
	instructions: string;
	mcp: PublicMcpServer[];
}

export interface SettingsPatch {
	language?: AppLanguageChoice;
	chat?: ChatSettingsPatch;
	models?: Partial<Record<ModelSlotId, SlotPatch>>;
	sandbox?: boolean;
	instructions?: string;
	mcp?: { upsert?: McpUpsert[]; remove?: string[] };
}

interface SlotPatch {
	requestUrl?: string;
	model?: string;
	enabled?: boolean;
	apiKey?: string;
	clearApiKey?: boolean;
}

interface McpUpsert {
	id: string;
	transport?: "stdio" | "http";
	enabled?: boolean;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

export interface SettingsToolHost {
	read(chatProvider?: string): Promise<PublicSettings>;
	apply(patch: SettingsPatch): Promise<{ notes: string[]; settings: PublicSettings }>;
}

export function publicModelSlot(slot: ModelSlotRecord): PublicModelSlot {
	return {
		requestUrl: slot.requestUrl,
		model: slot.model,
		enabled: slot.enabled,
		hasApiKey: slot.apiKey.trim().length > 0,
	};
}

export function publicMcpServer(draft: McpServerDraft): PublicMcpServer {
	return {
		id: draft.id,
		transport: draft.transport,
		enabled: draft.enabled,
		command: draft.transport === "stdio" ? draft.command : "",
		args: draft.transport === "stdio" ? linesOf(draft.argsText) : [],
		url: draft.transport === "http" ? draft.url : "",
		cwd: draft.transport === "stdio" ? draft.cwd : "",
		hasEnv: draft.transport === "stdio" && draft.envText.trim().length > 0,
		hasHeaders: draft.transport === "http" && draft.headersText.trim().length > 0,
	};
}

export function modelChangeNotes(before: ModelSettingsFile, after: ModelSettingsFile): string[] {
	const notes: string[] = [];
	if (before.embedding.model.trim() !== after.embedding.model.trim()) {
		notes.push("Embedding model changed. Existing text index rows for the previous model stay unused until those files are embedded again.");
	}
	if (before.vlm.model.trim() !== after.vlm.model.trim()) {
		notes.push("VLM model changed. Existing image and video write-ups for the previous model stay unused until those files are described again.");
	}
	if (before.audio.model.trim() !== after.audio.model.trim()) {
		notes.push("Audio model changed. Existing audio write-ups for the previous model stay unused until those files are described again.");
	}
	return notes;
}

export function modelDraftForPatch(file: ModelSettingsFile, patch: SettingsPatch["models"]): ModelSettingsDraft {
	const draft = {} as ModelSettingsDraft;
	for (const id of MODEL_SLOTS) draft[id] = slotDraft(file[id], patch?.[id]);
	return draft;
}

function slotDraft(current: ModelSlotRecord, patch: SlotPatch | undefined): ModelSlotDraft {
	const next: ModelSlotDraft = {
		requestUrl: patch?.requestUrl ?? current.requestUrl,
		model: patch?.model ?? current.model,
		enabled: patch?.enabled ?? current.enabled,
	};
	if (patch?.clearApiKey && patch.apiKey !== undefined) throw new Error("A slot cannot set and clear its API key in one change.");
	if (patch?.clearApiKey) next.clearApiKey = true;
	else if (patch?.apiKey !== undefined) next.apiKey = patch.apiKey;
	return next;
}

export function mergeMcpServers(current: readonly McpServerDraft[], patch: NonNullable<SettingsPatch["mcp"]>): McpServerDraft[] {
	const removed = new Set((patch.remove ?? []).map((id) => id.trim()).filter(Boolean));
	const next = current.filter((draft) => !removed.has(draft.id.trim()));
	for (const upsert of patch.upsert ?? []) {
		const id = upsert.id.trim();
		const index = next.findIndex((draft) => draft.id.trim() === id);
		const merged = mergeMcpServer(index >= 0 ? next[index] : undefined, { ...upsert, id });
		if (index >= 0) next[index] = merged;
		else next.push(merged);
	}
	return next;
}

function mergeMcpServer(current: McpServerDraft | undefined, upsert: McpUpsert): McpServerDraft {
	const transport = upsert.transport ?? current?.transport;
	if (transport !== "stdio" && transport !== "http") throw new Error(`MCP server ${upsert.id} needs a type: stdio or http.`);
	const same = current?.transport === transport ? current : undefined;
	if (transport === "http") {
		return {
			...emptyMcpServerDraft(),
			id: upsert.id,
			transport,
			url: upsert.url ?? same?.url ?? "",
			headersText: upsert.headers ? envToText(upsert.headers) : same?.headersText ?? "",
			enabled: upsert.enabled ?? same?.enabled ?? false,
		};
	}
	return {
		...emptyMcpServerDraft(),
		id: upsert.id,
		transport,
		command: upsert.command ?? same?.command ?? "",
		argsText: upsert.args ? upsert.args.join("\n") : same?.argsText ?? "",
		envText: upsert.env ? envToText(upsert.env) : same?.envText ?? "",
		cwd: upsert.cwd ?? same?.cwd ?? "",
		enabled: upsert.enabled ?? same?.enabled ?? false,
	};
}

export function parseSettingsPatch(value: unknown): SettingsPatch {
	const record = asRecord(value, "update_settings arguments must be an object");
	if (Object.keys(record).some((key) => !["language", "chat", "models", "sandbox", "instructions", "mcp"].includes(key))) throw new Error("Unknown settings field");
	const patch: SettingsPatch = {};
	if ("language" in record && record.language !== undefined) {
		if (!(APP_LANGUAGE_CHOICES as readonly unknown[]).includes(record.language)) throw new Error("language must be system, en, or zh-CN");
		patch.language = record.language as AppLanguageChoice;
	}
	if ("chat" in record && record.chat !== undefined) patch.chat = parseChatSettingsPatch(record.chat);
	if ("models" in record && record.models !== undefined) patch.models = parseModels(record.models);
	if ("sandbox" in record && record.sandbox !== undefined) {
		if (typeof record.sandbox !== "boolean") throw new Error("sandbox must be true or false.");
		patch.sandbox = record.sandbox;
	}
	if ("instructions" in record && record.instructions !== undefined) {
		if (typeof record.instructions !== "string") throw new Error("instructions must be text.");
		patch.instructions = record.instructions;
	}
	if ("mcp" in record && record.mcp !== undefined) patch.mcp = parseMcp(record.mcp);
	if (patch.language === undefined && !patch.chat && !patch.models && patch.sandbox === undefined && patch.instructions === undefined && !patch.mcp) {
		throw new Error("update_settings needs at least one change.");
	}
	return patch;
}

function parseModels(value: unknown): NonNullable<SettingsPatch["models"]> {
	const record = asRecord(value, "models must be an object");
	const models: NonNullable<SettingsPatch["models"]> = {};
	for (const [key, slot] of Object.entries(record)) {
		if (!isSlotId(key)) throw new Error(`Unknown model slot ${key}.`);
		models[key] = parseSlot(slot, key);
	}
	if (Object.keys(models).length === 0) throw new Error("models needs at least one slot.");
	return models;
}

function parseSlot(value: unknown, id: string): SlotPatch {
	const record = asRecord(value, `Slot ${id} must be an object`);
	if (Object.keys(record).some((key) => !Object.hasOwn(SLOT_FIELDS.properties, key))) throw new Error(`Unknown field in model slot ${id}.`);
	const slot: SlotPatch = {};
	if ("requestUrl" in record && record.requestUrl !== undefined) slot.requestUrl = needString(record.requestUrl, `${id}.requestUrl`);
	if ("model" in record && record.model !== undefined) slot.model = needString(record.model, `${id}.model`);
	if ("enabled" in record && record.enabled !== undefined) {
		if (typeof record.enabled !== "boolean") throw new Error(`${id}.enabled must be true or false.`);
		slot.enabled = record.enabled;
	}
	if ("apiKey" in record && record.apiKey !== undefined) slot.apiKey = needString(record.apiKey, `${id}.apiKey`);
	if ("clearApiKey" in record && record.clearApiKey !== undefined) {
		if (record.clearApiKey !== true) throw new Error(`${id}.clearApiKey must be true.`);
		slot.clearApiKey = true;
	}
	if (Object.keys(slot).length === 0) throw new Error(`Slot ${id} needs at least one field.`);
	return slot;
}

function parseMcp(value: unknown): NonNullable<SettingsPatch["mcp"]> {
	const record = asRecord(value, "mcp must be an object");
	const mcp: NonNullable<SettingsPatch["mcp"]> = {};
	if ("remove" in record && record.remove !== undefined) {
		if (!Array.isArray(record.remove) || record.remove.some((id) => typeof id !== "string" || !id.trim())) {
			throw new Error("mcp.remove must be a list of server ids.");
		}
		mcp.remove = record.remove;
	}
	if ("upsert" in record && record.upsert !== undefined) {
		if (!Array.isArray(record.upsert)) throw new Error("mcp.upsert must be a list of servers.");
		mcp.upsert = record.upsert.map(parseMcpUpsert);
	}
	if ((!mcp.remove || mcp.remove.length === 0) && (!mcp.upsert || mcp.upsert.length === 0)) {
		throw new Error("mcp needs a server to add, change, or remove.");
	}
	return mcp;
}

function parseMcpUpsert(value: unknown): McpUpsert {
	const record = asRecord(value, "Each MCP server must be an object");
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) throw new Error("Each MCP server needs an id.");
	const upsert: McpUpsert = { id };
	if ("transport" in record && record.transport !== undefined) {
		if (record.transport !== "stdio" && record.transport !== "http") throw new Error(`MCP server ${id} needs a type: stdio or http.`);
		upsert.transport = record.transport;
	}
	if ("enabled" in record && record.enabled !== undefined) {
		if (typeof record.enabled !== "boolean") throw new Error(`MCP server ${id} enabled must be true or false.`);
		upsert.enabled = record.enabled;
	}
	if ("command" in record && record.command !== undefined) upsert.command = needString(record.command, `${id}.command`);
	if ("args" in record && record.args !== undefined) upsert.args = needStringList(record.args, `${id}.args`);
	if ("cwd" in record && record.cwd !== undefined) upsert.cwd = needString(record.cwd, `${id}.cwd`);
	if ("url" in record && record.url !== undefined) upsert.url = needString(record.url, `${id}.url`);
	if ("env" in record && record.env !== undefined) upsert.env = needStringMap(record.env, `${id}.env`);
	if ("headers" in record && record.headers !== undefined) upsert.headers = needStringMap(record.headers, `${id}.headers`);
	return upsert;
}

function isSlotId(value: string): value is ModelSlotId {
	return (MODEL_SLOTS as readonly string[]).includes(value);
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
	return value as Record<string, unknown>;
}

function needString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be text.`);
	return value;
}

function needStringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a list of strings.`);
	return value;
}

function needStringMap(value: unknown, label: string): Record<string, string> {
	const record = asRecord(value, `${label} must be an object of strings.`);
	const mapped: Record<string, string> = {};
	for (const [key, item] of Object.entries(record)) {
		if (typeof item !== "string") throw new Error(`${label}.${key} must be text.`);
		mapped[key] = item;
	}
	return mapped;
}

const SLOT_FIELDS = {
	type: "object",
	properties: {
		requestUrl: { type: "string", description: "Complete HTTP(S) request URL including the operation path. Used exactly as supplied; no version/path is appended or rewritten." },
		model: { type: "string" },
		enabled: { type: "boolean" },
		apiKey: { type: "string", description: "Replaces the stored key. The value remains in this chat." },
		clearApiKey: { type: "boolean", description: "True removes the stored key." },
	},
	additionalProperties: false,
} as const;

/** Read and patch app settings. Keys are write-only. */
export function createSettingsTools(host: SettingsToolHost): LoomTool[] {
	return [
		{
			name: "get_settings",
			description:
				"Read app language, Chat providers/model capabilities/auth status, four other model slots, sandbox, instructions, and MCP. " +
				"Secrets are never returned. Chat catalog lists provider summaries; pass chatProvider to inspect that provider's model catalog before configuring it.",
			parameters: { type: "object", properties: { chatProvider: { type: "string", description: "Provider ID whose full Chat model catalog should be included (configured or built-in)." } }, additionalProperties: false },
			execute: async (raw) => {
				const args = asRecord(raw, "get_settings arguments must be an object");
				if (Object.keys(args).some((key) => key !== "chatProvider")) throw new Error("Unknown get_settings argument");
				const chatProvider = args.chatProvider === undefined ? undefined : needString(args.chatProvider, "chatProvider");
				return JSON.stringify(await host.read(chatProvider), null, 2);
			},
		},
		{
			name: "update_settings",
			description:
				"Change app settings. Omit a field to leave it unchanged. " +
				"language accepts system, en, zh-CN. chat.upsert adds/patches built-in or custom providers; chat.remove removes them; chat.refresh refreshes supported catalogs. " +
				"Custom providers need kind=custom, models and requestUrl (auto protocol) or baseUrl + api. models replaces a custom model list; modelEnabled merges per-ID switches. " +
				"Chat apiKey/clearApiKey are write-only and use encrypted storage; clearing preserves OAuth and cannot clear environmental keys. No interactive OAuth or conversation-model changes. Existing conversations keep their choices. " +
				"models accepts embedding, rerank, vlm, and audio. " +
				"apiKey replaces the stored key and stays in this chat; clearApiKey removes it. " +
				"sandbox and instructions match Settings → Agent. Instructions apply on the next message, not this one. " +
				"mcp.upsert adds or updates a server by id (stdio needs command; http needs url). mcp.remove deletes by id. Enabled servers reconnect. " +
				"Changing the embedding, VLM, or audio model leaves previous write-ups unused until those files are indexed again. " +
				"Basic and Standard ask before this runs.",
			parameters: {
				type: "object",
				properties: {
					language: { type: "string", enum: [...APP_LANGUAGE_CHOICES] },
					chat: chatSettingsPatchSchema(),
					models: {
						type: "object",
						properties: {
							embedding: SLOT_FIELDS,
							rerank: SLOT_FIELDS,
							vlm: SLOT_FIELDS,
							audio: SLOT_FIELDS,
						},
						additionalProperties: false,
					},
					sandbox: { type: "boolean" },
					instructions: { type: "string" },
					mcp: {
						type: "object",
						properties: {
							upsert: {
								type: "array",
								items: {
									type: "object",
									properties: {
										id: { type: "string" },
										transport: { type: "string", enum: ["stdio", "http"] },
										enabled: { type: "boolean" },
										command: { type: "string" },
										args: { type: "array", items: { type: "string" } },
										env: { type: "object", additionalProperties: { type: "string" } },
										cwd: { type: "string" },
										url: { type: "string" },
										headers: { type: "object", additionalProperties: { type: "string" } },
									},
									required: ["id"],
									additionalProperties: false,
								},
							},
							remove: { type: "array", items: { type: "string" } },
						},
						additionalProperties: false,
					},
				},
				additionalProperties: false,
			},
			execute: async (raw) => {
				const applied = await host.apply(parseSettingsPatch(raw));
				return JSON.stringify({ notes: applied.notes, settings: applied.settings }, null, 2);
			},
		},
	];
}
