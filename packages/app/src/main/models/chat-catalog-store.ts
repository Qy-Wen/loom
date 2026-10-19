import type { AnyModel, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { assertJson, assertPublicMetadata, validateChatBaseUrl } from "@loom/agent/chat-models";
import { JsonFile, type StorageOptions } from "../storage/file.ts";
import { normalizeStorageJson, validateStorageId } from "./chat-storage-validation.ts";

type CatalogFile = { version: 1; entries: Record<string, ModelsStoreEntry> };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const number = (value: unknown): value is number => finite(value) && value >= 0;

function parseEntry(value: unknown, providerId: string, stripHeaders = false): ModelsStoreEntry {
	assertJson(value);
	if (!record(value) || !Array.isArray(value.models) || Object.keys(value).some((key) => !["models", "checkedAt", "lastModified", "etag"].includes(key)) || (value.checkedAt !== undefined && !number(value.checkedAt)) || (value.lastModified !== undefined && !number(value.lastModified)) || (value.etag !== undefined && typeof value.etag !== "string")) throw new Error("Invalid Chat catalog entry");
	const ids = new Set<string>();
	const models = value.models.map((candidate) => {
		if (!record(candidate)) throw new Error("Invalid Chat catalog model");
		const model = structuredClone(candidate);
		if (stripHeaders) delete model.headers;
		const publicFields = structuredClone(model);
		// Radius's routing entries contain a literal auth-source reference, not a credential object.
		if (providerId === "radius" && Array.isArray(publicFields.providers)) for (const route of publicFields.providers) {
			if (record(route) && route.credential === "radius") delete route.credential;
		}
		assertPublicMetadata(publicFields);
		if (![model.id, model.name, model.api].every((value) => typeof value === "string" && value.length > 0) || typeof model.baseUrl !== "string" || model.provider !== providerId || !Array.isArray(model.input) || !model.input.length || model.input.some((value) => value !== "text" && value !== "image") || !record(model.cost) || !["input", "output", "cacheRead", "cacheWrite"].every((key) => finite((model.cost as Record<string, unknown>)[key]))) throw new Error("Invalid Chat catalog model metadata");
		// Ambient cloud Providers may publish an empty endpoint resolved during authentication.
		if (model.baseUrl) validateChatBaseUrl(model.baseUrl as string);
		const type = model.type ?? "chat";
		if (!["chat", "image", "classifier"].includes(type as string)) throw new Error("Unknown catalog model operation");
		if (type !== "image" && (!Number.isSafeInteger(model.contextWindow) || Number(model.contextWindow) <= 0)) throw new Error("Invalid catalog context window");
		if (type === "chat" && (typeof model.reasoning !== "boolean" || !Number.isSafeInteger(model.maxTokens) || Number(model.maxTokens) <= 0)) throw new Error("Invalid catalog chat capabilities");
		if (type === "image" && (!Array.isArray(model.output) || !model.output.includes("image") || model.output.some((part) => part !== "text" && part !== "image"))) throw new Error("Invalid catalog image capabilities");
		const key = `${type}:${String(model.id)}`;
		if (ids.has(key)) throw new Error("Duplicate catalog model");
		ids.add(key);
		return model as unknown as AnyModel;
	});
	return { ...value, models } as ModelsStoreEntry;
}
function parseCatalog(value: unknown): CatalogFile {
	assertJson(value);
	if (!record(value) || value.version !== 1 || !record(value.entries) || Object.keys(value).some((key) => !["version", "entries"].includes(key))) throw new Error("Invalid or unsupported Chat catalog file");
	const entries = Object.fromEntries(Object.entries(value.entries).map(([id, entry]) => { validateStorageId(id); return [id, parseEntry(entry, id)]; }));
	return { version: 1, entries };
}

/** Persist native catalogs only; request headers are reapplied from encrypted secrets, never cached. */
export class ChatCatalogStore implements ModelsStore {
	readonly file: JsonFile<CatalogFile>;
	constructor(path: string) { this.file = new JsonFile(path, parseCatalog); }
	async read(id: string, options?: StorageOptions): Promise<ModelsStoreEntry | undefined> {
		validateStorageId(id);
		const file = await this.file.read(options);
		return file && Object.prototype.hasOwnProperty.call(file.entries, id) ? file.entries[id] : undefined;
	}
	async write(id: string, entry: ModelsStoreEntry, options?: StorageOptions): Promise<void> {
		validateStorageId(id);
		const safe = parseEntry(normalizeStorageJson(entry), id, true);
		await this.file.update(async (current) => {
			const next = current ?? { version: 1 as const, entries: {} };
			Object.defineProperty(next.entries, id, { value: safe, enumerable: true, configurable: true, writable: true });
			return { value: next, result: undefined };
		}, options);
	}
	async delete(id: string, options?: StorageOptions): Promise<void> {
		validateStorageId(id);
		await this.file.update(async (current) => {
			if (!current || !Object.prototype.hasOwnProperty.call(current.entries, id)) return { result: undefined };
			delete current.entries[id];
			return { value: current, result: undefined };
		}, options);
	}
}
