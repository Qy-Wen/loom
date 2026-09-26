import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { envToText, draftToRawServer, type McpServerDraft } from "../../shared/mcp-settings.ts";
import { loadMcpConfigFile, parseMcpConfig } from "./config.ts";
import { isHttpServer, type McpServerConfig } from "./types.ts";

export function configToDraft(config: McpServerConfig): McpServerDraft {
	if (isHttpServer(config)) {
		return {
			id: config.id,
			transport: "http",
			command: "",
			argsText: "",
			envText: "",
			cwd: "",
			url: config.url,
			headersText: envToText(config.headers),
			enabled: config.enabled,
		};
	}
	return {
		id: config.id,
		transport: "stdio",
		command: config.command,
		argsText: (config.args ?? []).join("\n"),
		envText: envToText(config.env),
		cwd: config.cwd ?? "",
		url: "",
		headersText: "",
		enabled: config.enabled,
	};
}

export function configFromDraft(draft: McpServerDraft, env: NodeJS.ProcessEnv = process.env): McpServerConfig {
	const [config] = parseMcpConfig(draftsToFile([draft]), env);
	if (!config) throw new Error("MCP server is invalid");
	return config;
}

export function draftsToFile(drafts: McpServerDraft[]): { servers: Record<string, unknown>[] } {
	return {
		servers: drafts
			.filter((draft) => draft.id.trim())
			.map((draft) => draftToRawServer(draft)),
	};
}

export class McpSettingsStore {
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	path(): string {
		return this.filePath;
	}

	async ensure(): Promise<void> {
		if (existsSync(this.filePath)) return;
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify({ servers: [] }, null, "\t")}\n`, "utf8");
	}

	async load(): Promise<McpServerConfig[]> {
		await this.ensure();
		return loadMcpConfigFile(this.filePath);
	}

	async drafts(): Promise<McpServerDraft[]> {
		return (await this.load()).map(configToDraft);
	}

	async save(drafts: McpServerDraft[]): Promise<McpServerConfig[]> {
		for (const draft of drafts) {
			if (!draft.id.trim()) throw new Error("Each MCP server needs an id");
			if (draft.transport === "http" && !draft.url.trim()) {
				throw new Error(`MCP server ${draft.id.trim()} needs a URL`);
			}
			if (draft.transport === "stdio" && !draft.command.trim()) {
				throw new Error(`MCP server ${draft.id.trim()} needs a command`);
			}
		}
		const file = draftsToFile(drafts);
		parseMcpConfig(file);
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
		return loadMcpConfigFile(this.filePath);
	}
}
