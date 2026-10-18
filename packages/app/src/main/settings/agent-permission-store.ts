import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_AGENT_PERMISSION, parseAgentPermissionLevel, type AgentPermissionLevel } from "@loom/agent";

export class AgentPermissionStore {
	private readonly filePath: string;
	private level: AgentPermissionLevel = DEFAULT_AGENT_PERMISSION;
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	async load(): Promise<AgentPermissionLevel> {
		if (this.loaded) return this.level;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
			const raw = parsed && typeof parsed === "object" ? (parsed as { level?: unknown }).level : parsed;
			this.level = parseAgentPermissionLevel(raw);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.level = DEFAULT_AGENT_PERMISSION;
		}
		this.loaded = true;
		return this.level;
	}

	async save(level: AgentPermissionLevel): Promise<AgentPermissionLevel> {
		this.level = parseAgentPermissionLevel(level);
		this.loaded = true;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify({ level: this.level }, null, "\t")}\n`, "utf8");
		return this.level;
	}
}
