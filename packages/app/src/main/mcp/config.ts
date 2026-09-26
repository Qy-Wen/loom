import { readFile } from "node:fs/promises";
import type { McpServerConfig } from "./types.ts";

export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? "");
}

export function parseMcpConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): McpServerConfig[] {
	if (raw === undefined || raw === null) return [];
	if (typeof raw !== "object") throw new Error("MCP config must be an object");
	const record = raw as Record<string, unknown>;
	if (Array.isArray(record.servers)) return record.servers.map((entry) => parseServer(entry, env));
	if (record.mcpServers && typeof record.mcpServers === "object" && !Array.isArray(record.mcpServers)) {
		return Object.entries(record.mcpServers as Record<string, unknown>).map(([id, entry]) => {
			if (typeof entry !== "object" || entry === null) throw new Error(`MCP server ${id} is invalid`);
			return parseServer({ id, ...(entry as Record<string, unknown>) }, env);
		});
	}
	return [];
}

export async function loadMcpConfigFile(path: string, env: NodeJS.ProcessEnv = process.env): Promise<McpServerConfig[]> {
	const text = await readFile(path, "utf8");
	return parseMcpConfig(JSON.parse(text) as unknown, env);
}

function parseServer(value: unknown, env: NodeJS.ProcessEnv): McpServerConfig {
	if (typeof value !== "object" || value === null) throw new Error("MCP server entry must be an object");
	const record = value as Record<string, unknown>;
	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!id) throw new Error("MCP server id is required");
	if (typeof record.url === "string" && record.url.trim()) {
		return {
			id,
			url: expandEnv(record.url.trim(), env),
			headers: mapEnvStrings(record.headers, env),
			enabled: record.enabled !== false,
		};
	}
	if (typeof record.command === "string" && record.command.trim()) {
		return {
			id,
			command: expandEnv(record.command.trim(), env),
			args: Array.isArray(record.args) ? record.args.map((arg) => expandEnv(String(arg), env)) : undefined,
			env: mapEnvStrings(record.env, env),
			cwd: typeof record.cwd === "string" ? expandEnv(record.cwd, env) : undefined,
			enabled: record.enabled !== false,
		};
	}
	throw new Error(`MCP server ${id} needs command or url`);
}

function mapEnvStrings(value: unknown, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("MCP env/headers must be an object of strings");
	}
	const mapped: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item !== "string") throw new Error("MCP env/headers values must be strings");
		mapped[key] = expandEnv(item, env);
	}
	return mapped;
}
