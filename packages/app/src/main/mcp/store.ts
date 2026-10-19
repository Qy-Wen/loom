import { JsonFile } from "../storage/file.ts";
import { emptyMcpServerDraft, envToText, draftToRawServer, type McpServerDraft, type McpSettingsPatch } from "../../shared/mcp-settings.ts";
import { parseMcpConfig } from "./config.ts";
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

function validateDrafts(drafts: McpServerDraft[]): void {
	const ids = new Set<string>();
	for (const draft of drafts) {
		if (!draft.id.trim()) throw new Error("Each MCP server needs an id");
		if (ids.has(draft.id.trim())) throw new Error("Duplicate MCP server id");
		ids.add(draft.id.trim());
		if (draft.transport === "http" && !draft.url.trim()) throw new Error(`MCP server ${draft.id.trim()} needs a URL`);
		if (draft.transport === "stdio" && !draft.command.trim()) throw new Error(`MCP server ${draft.id.trim()} needs a command`);
	}
	parseMcpConfig(draftsToFile(drafts));
}

export function applyMcpSettingsPatch(current: McpServerDraft[], patch: McpSettingsPatch): McpServerDraft[] {
	const next = current.filter((row) => !patch.remove?.includes(row.id));
	for (const { previousId, server } of patch.upsert ?? []) {
		const id = server.id.trim();
		const index = next.findIndex((row) => row.id === (previousId ?? id));
		if (previousId !== undefined && index < 0) throw new Error(`MCP server ${previousId} no longer exists`);
		if (next.some((row, i) => i !== index && row.id === id)) throw new Error("Duplicate MCP server id");
		const merged = { ...(index < 0 ? emptyMcpServerDraft() : next[index]), ...server, id };
		if (index < 0) next.push(merged); else next[index] = merged;
	}
	return next;
}

export class McpSettingsStore {
	private readonly file: JsonFile<unknown>;

	constructor(filePath: string) {
		this.file = new JsonFile(filePath, (raw) => { parseMcpConfig(raw); return raw; });
	}

	path(): string { return this.file.path; }

	async ensure(): Promise<void> {
		await this.file.update(async (current) => current === undefined
			? { value: { servers: [] }, result: undefined } : { result: undefined });
	}

	async load(): Promise<McpServerConfig[]> {
		await this.ensure();
		return parseMcpConfig(await this.file.read());
	}

	async drafts(): Promise<McpServerDraft[]> {
		await this.ensure();
		return parseMcpConfig(await this.file.read(), null).map(configToDraft);
	}

	async save(drafts: McpServerDraft[]): Promise<McpServerConfig[]> {
		return this.update(() => drafts);
	}

	async patch(patch: McpSettingsPatch): Promise<McpServerConfig[]> {
		return this.update((current) => applyMcpSettingsPatch(current, patch));
	}

	async update(change: (current: McpServerDraft[]) => McpServerDraft[]): Promise<McpServerConfig[]> {
		return this.file.update(async (current) => {
			const drafts = change(parseMcpConfig(current, null).map(configToDraft));
			validateDrafts(drafts);
			const value = draftsToFile(drafts);
			return { value, result: parseMcpConfig(value) };
		});
	}
}
