import { parseMcpServiceSettings, type McpServiceSettings } from "../../shared/mcp-service.ts";
import type { ChatSecretCipher } from "../models/chat-credential-store.ts";
import { JsonFile } from "../storage/file.ts";

type StoredConfig = Omit<McpServiceSettings, "token"> & { encryptedToken: string };
const defaults = { enabled: false, port: 19441, token: "" };

export class McpServiceStore {
	readonly file: JsonFile<StoredConfig>;
	readonly cipher: ChatSecretCipher;
	constructor(path: string, cipher: ChatSecretCipher) {
		this.cipher = cipher;
		this.file = new JsonFile(path, (value) => {
			const { enabled, port } = parseMcpServiceSettings({ ...value as Record<string, unknown>, token: "" });
			const encryptedToken = (value as Record<string, unknown>).encryptedToken;
			if (typeof encryptedToken !== "string") throw new Error("Invalid encrypted MCP token");
			return { enabled, port, encryptedToken };
		});
	}
	async load(): Promise<McpServiceSettings> {
		const stored = await this.file.read();
		if (!stored) return { ...defaults };
		if (!stored.encryptedToken) return { enabled: stored.enabled, port: stored.port, token: "" };
		if (!this.cipher.available()) throw new Error("MCP token encryption is unavailable");
		const token = this.cipher.decrypt(Buffer.from(stored.encryptedToken, "base64"));
		return parseMcpServiceSettings({ enabled: stored.enabled, port: stored.port, token });
	}
	async save(settings: McpServiceSettings): Promise<McpServiceSettings> {
		const parsed = parseMcpServiceSettings(settings);
		if (parsed.token && !this.cipher.available()) throw new Error("MCP token encryption is unavailable; plaintext storage is disabled");
		return this.file.update(async () => {
			const { enabled, port, token } = parsed;
			return { value: { enabled, port, encryptedToken: token ? this.cipher.encrypt(token).toString("base64") : "" }, result: parsed };
		});
	}
}
