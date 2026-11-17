import { defaultCloudConfig, type CloudConfig, type CloudConfigDraft } from "../../shared/cloud-backup.ts";
import type { ChatSecretCipher } from "../models/chat-credential-store.ts";
import { JsonFile } from "../storage/file.ts";
import { storedCloudConnection, parseCloudConfig, parseCloudCredentialDraft, type CloudConnection } from "./providers.ts";

type Stored = CloudConfig & { credentials: string };

export class CloudConfigStore {
	readonly #file: JsonFile<Stored>;
	readonly #cipher: ChatSecretCipher;
	constructor(path: string, cipher: ChatSecretCipher) {
		this.#cipher = cipher;
		this.#file = new JsonFile(path, (input) => {
			const value = input as Stored;
			const config = parseCloudConfig(value);
			if (typeof value.credentials !== "string" || !value.credentials) throw new Error("Invalid encrypted cloud credentials");
			return { ...config, credentials: value.credentials };
		});
	}
	async view(): Promise<{ config: CloudConfig; hasCredentials: boolean }> {
		const value = await this.#file.read();
		return { config: value ? parseCloudConfig(value) : defaultCloudConfig(), hasCredentials: !!value };
	}
	async load(): Promise<CloudConnection> {
		const value = await this.#file.read();
		if (!value) throw new Error("Configure cloud storage first");
		return this.#connection(value);
	}
	/** Explicit settings editing read. Job views and events keep credentials out of their payloads. */
	async configuration(): Promise<CloudConfigDraft> {
		const value = await this.#file.read();
		return value ? this.#connection(value) : defaultCloudConfig();
	}
	#connection(value: Stored): CloudConnection {
		let payload: unknown;
		try { payload = JSON.parse(this.#cipher.decrypt(Buffer.from(value.credentials, "base64"))); }
		catch { throw new Error("Cannot decrypt cloud credentials on this computer. Enter them again."); }
		return storedCloudConnection(parseCloudConfig(value), payload);
	}
	async save(draft: CloudConfigDraft): Promise<void> {
		const config = parseCloudConfig(draft);
		const replacement = parseCloudCredentialDraft(config.provider, draft.credentials);
		if (!this.#cipher.available()) throw new Error("System credential encryption is unavailable");
		await this.#file.update(async (current) => {
			let credentials = current?.provider === config.provider ? current.credentials : undefined;
			if (replacement) credentials = this.#cipher.encrypt(JSON.stringify({ provider: config.provider, credentials: replacement })).toString("base64");
			if (!credentials) throw new Error("Enter credentials for the selected cloud provider");
			return { value: { ...config, credentials }, result: undefined };
		});
	}
}
