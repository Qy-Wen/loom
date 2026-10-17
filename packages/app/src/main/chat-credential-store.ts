import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { assertJson } from "@loom/agent/chat-models";
import { ChatJsonFile, normalizeStorageJson, validateStorageId, type StorageOptions } from "./chat-file.ts";

/** Inject Electron safeStorage in Main; unit tests use a real authenticated test cipher. */
export interface ChatSecretCipher {
	available(): boolean;
	encrypt(plaintext: string): Buffer;
	decrypt(ciphertext: Buffer): string;
}
type EncryptedEntry = { type?: Credential["type"]; data: string };
type CredentialFile = { version: 1; entries: Record<string, EncryptedEntry> };
type SecretPayload = { credential?: Credential; secrets: Record<string, string> };
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function strings(value: unknown): value is Record<string, string> { return record(value) && Object.values(value).every((entry) => typeof entry === "string"); }

function parseCredential(value: unknown): Credential {
	assertJson(value);
	if (!record(value)) throw new Error("Invalid Chat credential");
	if (value.type === "api_key" && (value.key === undefined || typeof value.key === "string") && (value.env === undefined || strings(value.env)) && Object.keys(value).every((key) => ["type", "key", "env"].includes(key))) return structuredClone(value) as Credential;
	if (value.type === "oauth" && typeof value.access === "string" && value.access.length > 0 && typeof value.refresh === "string" && typeof value.expires === "number" && Number.isFinite(value.expires) && value.expires >= 0 && value.expires <= Number.MAX_SAFE_INTEGER) return structuredClone(value) as Credential;
	throw new Error("Invalid Chat credential");
}

function parseCredentialFile(value: unknown): CredentialFile {
	assertJson(value);
	if (!record(value) || value.version !== 1 || !record(value.entries) || Object.keys(value).some((key) => !["version", "entries"].includes(key))) throw new Error("Invalid or unsupported Chat credential file");
	for (const [id, entry] of Object.entries(value.entries)) {
		validateStorageId(id);
		if (!record(entry) || typeof entry.data !== "string" || !entry.data.length || Buffer.from(entry.data, "base64").toString("base64") !== entry.data || (entry.type !== undefined && entry.type !== "api_key" && entry.type !== "oauth") || Object.keys(entry).some((key) => !["type", "data"].includes(key))) throw new Error("Invalid encrypted Chat credential entry");
	}
	return structuredClone(value) as CredentialFile;
}

/** A single file lock serializes all mutations, including OAuth refresh and header-secret edits. */
export class ChatCredentialStore implements CredentialStore {
	readonly file: ChatJsonFile<CredentialFile>;
	readonly cipher: ChatSecretCipher;
	constructor(path: string, cipher: ChatSecretCipher) { this.file = new ChatJsonFile(path, parseCredentialFile); this.cipher = cipher; }
	assertEncryptionAvailable(): void { if (!this.cipher.available()) throw new Error("Chat credential encryption is unavailable; plaintext fallback is disabled"); }
	private decode(entry: EncryptedEntry | undefined): SecretPayload {
		if (!entry) return { secrets: {} };
		this.assertEncryptionAvailable();
		try {
			const payload: unknown = JSON.parse(this.cipher.decrypt(Buffer.from(entry.data, "base64")));
			assertJson(payload);
			if (!record(payload) || !strings(payload.secrets) || Object.keys(payload).some((key) => !["credential", "secrets"].includes(key))) throw new Error();
			const credential = payload.credential === undefined ? undefined : parseCredential(payload.credential);
			if (credential?.type !== entry.type) throw new Error();
			return { ...(credential ? { credential } : {}), secrets: payload.secrets };
		} catch { throw new Error("Cannot decrypt or validate Chat credentials; reconnect the provider"); }
	}
	private encode(payload: SecretPayload): EncryptedEntry {
		this.assertEncryptionAvailable();
		try { return { ...(payload.credential ? { type: payload.credential.type } : {}), data: this.cipher.encrypt(JSON.stringify(payload)).toString("base64") }; }
		catch { throw new Error("Cannot encrypt Chat credentials"); }
	}
	private entry(file: CredentialFile | undefined, id: string): EncryptedEntry | undefined { return file && own(file.entries, id) ? file.entries[id] : undefined; }
	async read(id: string, options?: StorageOptions): Promise<Credential | undefined> {
		validateStorageId(id);
		return this.decode(this.entry(await this.file.read(options), id)).credential;
	}
	async list(options?: StorageOptions): Promise<readonly CredentialInfo[]> {
		const file = await this.file.read(options);
		return Object.entries(file?.entries ?? {}).flatMap(([providerId, entry]) => entry.type ? [{ providerId, type: entry.type }] : []);
	}
	async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: StorageOptions): Promise<Credential | undefined> {
		validateStorageId(id);
		return this.file.update(async (current) => {
			const payload = this.decode(this.entry(current, id));
			const candidate = await fn(payload.credential);
			if (candidate === undefined) return { result: this.decode(this.entry(current, id)).credential };
			payload.credential = parseCredential(normalizeStorageJson(candidate));
			const next = current ?? { version: 1 as const, entries: {} };
			Object.defineProperty(next.entries, id, { value: this.encode(payload), enumerable: true, configurable: true, writable: true });
			return { value: next, result: structuredClone(payload.credential) };
		}, options);
	}
	/** Clear a stored API key without racing OAuth updates or removing encrypted header secrets. */
	async clearApiKey(id: string, options?: StorageOptions): Promise<void> {
		return this.removeCredential(id, true, options);
	}
	async delete(id: string, options?: StorageOptions): Promise<void> {
		return this.removeCredential(id, false, options);
	}
	private async removeCredential(id: string, apiKeyOnly: boolean, options?: StorageOptions): Promise<void> {
		validateStorageId(id);
		await this.file.update(async (current) => {
			if (!this.entry(current, id)) return { result: undefined };
			const payload = this.decode(this.entry(current, id));
			if (apiKeyOnly && payload.credential?.type !== "api_key") return { result: undefined };
			delete payload.credential;
			if (Object.keys(payload.secrets).length) current!.entries[id] = this.encode(payload);
			else delete current!.entries[id];
			return { value: current, result: undefined };
		}, options);
	}
	async getSecret(id: string, name: string, options?: StorageOptions): Promise<string | undefined> {
		validateStorageId(id); validateStorageId(name);
		const secrets = this.decode(this.entry(await this.file.read(options), id)).secrets;
		return own(secrets, name) ? secrets[name] : undefined;
	}
	async setSecret(id: string, name: string, value: string | undefined, options?: StorageOptions): Promise<void> {
		validateStorageId(id); validateStorageId(name);
		await this.file.update(async (current) => {
			const payload = this.decode(this.entry(current, id));
			if (value === undefined) delete payload.secrets[name];
			else Object.defineProperty(payload.secrets, name, { value, enumerable: true, configurable: true, writable: true });
			const next = current ?? { version: 1 as const, entries: {} };
			if (!payload.credential && !Object.keys(payload.secrets).length) delete next.entries[id];
			else Object.defineProperty(next.entries, id, { value: this.encode(payload), enumerable: true, configurable: true, writable: true });
			return { value: next, result: undefined };
		}, options);
	}
}
