import { DEFAULT_AGENT_PERMISSION, parseAgentPermissionLevel, type AgentPermissionLevel } from "@loom/agent";
import { JsonFile } from "../storage/file.ts";

export class AgentPermissionStore {
	private readonly file: JsonFile<{ level: AgentPermissionLevel }>;
	constructor(filePath: string) {
		this.file = new JsonFile(filePath, (value) => ({
			level: parseAgentPermissionLevel(value && typeof value === "object" ? (value as { level?: unknown }).level : value),
		}));
	}

	async load(): Promise<AgentPermissionLevel> {
		return (await this.file.read())?.level ?? DEFAULT_AGENT_PERMISSION;
	}

	async save(level: AgentPermissionLevel): Promise<AgentPermissionLevel> {
		const value = { level: parseAgentPermissionLevel(level) };
		return this.file.update(async () => ({ value, result: value.level }));
	}
}
