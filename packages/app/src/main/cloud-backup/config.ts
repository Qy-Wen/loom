import { defaultCloudConfig, type ActiveCloudConfig, type CloudConfig, type CloudConfigDraft, type CloudProviderId } from "../../shared/cloud-backup.ts";
import type { ChatSecretCipher } from "../models/chat-credential-store.ts";
import { JsonFile } from "../storage/file.ts";
import { storedCloudConnection, parseCloudConfig, parseCloudCredentialDraft, type CloudConnection } from "./providers.ts";

type StoredConnection = ActiveCloudConfig & { credentials: string };
type Stored = StoredConnection | { provider: "none"; previous?: StoredConnection };

function parseConnection(input: unknown): StoredConnection {
	const config = parseCloudConfig(input);
	const value = input as StoredConnection;
	if (config.provider === "none" || typeof value.credentials !== "string" || !value.credentials) throw new Error("Invalid encrypted cloud credentials");
	return { ...config, credentials: value.credentials };
}

export class CloudConfigStore {
	readonly #file: JsonFile<Stored>;
	readonly #cipher: ChatSecretCipher;
	constructor(path: string, cipher: ChatSecretCipher) {
		this.#cipher = cipher;
		this.#file = new JsonFile<Stored>(path, (input) => {
			const value = input as Stored;
			const config = parseCloudConfig(value);
			if (config.provider === "none") return { provider: "none", previous: value.provider === "none" && value.previous ? parseConnection(value.previous) : undefined };
			return parseConnection(value);
		});
	}
	async view(): Promise<{ config: CloudConfig; hasCredentials: boolean }> {
		const value = await this.#file.read();
		return { config: value ? parseCloudConfig(value) : defaultCloudConfig(), hasCredentials: !!value && value.provider !== "none" };
	}
	async load(): Promise<CloudConnection> {
		const value = await this.#file.read();
		if (!value) throw new Error("Configure cloud storage first");
		if (value.provider === "none") throw new Error("Cloud storage is disabled. Choose a storage provider first.");
		return this.#connection(value);
	}
	/** Explicit settings editing read. Job views and events keep credentials out of their payloads. */
	async configuration(provider?: CloudProviderId): Promise<CloudConfigDraft> {
		const value = await this.#file.read();
		if (provider === "none" || (provider === undefined && (!value || value.provider === "none"))) return defaultCloudConfig();
		const saved = value?.provider === "none" ? value.previous : value;
		return saved && (provider === undefined || saved.provider === provider) ? this.#connection(saved) : defaultCloudConfig(provider);
	}
	#connection(value: StoredConnection): CloudConnection {
		let payload: unknown;
		try { payload = JSON.parse(this.#cipher.decrypt(Buffer.from(value.credentials, "base64"))); }
		catch { throw new Error("Cannot decrypt cloud credentials on this computer. Enter them again."); }
		const { credentials: _credentials, ...config } = value;
		return storedCloudConnection(config, payload);
	}
	async save(draft: CloudConfigDraft): Promise<void> {
		const config = parseCloudConfig(draft);
		if (config.provider === "none") {
			await this.#file.update(async (current) => ({ value: { provider: "none", previous: current?.provider === "none" ? current.previous : current }, result: undefined }));
			return;
		}
		const replacement = parseCloudCredentialDraft(config.provider, "credentials" in draft ? draft.credentials : undefined);
		if (!this.#cipher.available()) throw new Error("System credential encryption is unavailable");
		await this.#file.update(async (current) => {
			const previous = current?.provider === "none" ? current.previous : current;
			let credentials = previous?.provider === config.provider ? previous.credentials : undefined;
			if (replacement) credentials = this.#cipher.encrypt(JSON.stringify({ provider: config.provider, credentials: replacement })).toString("base64");
			if (!credentials) throw new Error("Enter credentials for the selected cloud provider");
			return { value: { ...config, credentials }, result: undefined };
		});
	}
}
