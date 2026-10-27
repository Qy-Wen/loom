import { randomUUID } from "node:crypto";
import { atomicWrite, decodeJson, encodeJson, readOptionalFile, withFileLock } from "../storage/file.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stable ID of this app installation, created on first use. Some login flows (OpenAI's "Sign in with
 * ChatGPT") send it to identify the agent host. It lives in app user data, never in a library, because
 * a library can be copied to another computer and the ID must stay with the installation.
 */
export class DeviceIdStore {
	readonly #path: string;
	#cached?: string;

	constructor(path: string) { this.#path = path; }

	/** Returns the same ID on every later call, including from another process. */
	async get(): Promise<string> {
		if (this.#cached) return this.#cached;
		this.#cached = await withFileLock(this.#path, async () => {
			const text = await readOptionalFile(this.#path);
			if (text !== undefined) {
				const stored = (decodeJson(text) as { deviceId?: unknown } | null)?.deviceId;
				if (typeof stored === "string" && UUID.test(stored)) return stored.toLowerCase();
				// Never overwrite a file we cannot read: a different value would change this installation's identity.
				throw new Error("Device ID file is invalid");
			}
			const created = randomUUID();
			await atomicWrite(this.#path, encodeJson({ deviceId: created }));
			return created;
		});
		return this.#cached;
	}
}
