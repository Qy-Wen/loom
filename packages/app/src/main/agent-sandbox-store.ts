import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_PROCESS_SANDBOX, parseProcessSandboxEnabled } from "../shared/agent-sandbox.ts";

export class AgentSandboxStore {
	private readonly filePath: string;
	private enabled = DEFAULT_PROCESS_SANDBOX;
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<boolean> {
		if (this.loaded) return this.enabled;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			const raw = parsed && typeof parsed === "object" ? (parsed as { enabled?: unknown }).enabled : parsed;
			this.enabled = parseProcessSandboxEnabled(raw);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.enabled = DEFAULT_PROCESS_SANDBOX;
		}
		this.loaded = true;
		return this.enabled;
	}

	async save(enabled: boolean): Promise<boolean> {
		this.enabled = enabled;
		this.loaded = true;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify({ enabled: this.enabled }, null, "\t")}\n`, "utf8");
		return this.enabled;
	}
}
