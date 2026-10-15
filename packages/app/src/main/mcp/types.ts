import type { LoomToolResult } from "@loom/agent";

export interface McpStdioServerConfig {
	id: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	enabled: boolean;
}

export interface McpHttpServerConfig {
	id: string;
	url: string;
	headers?: Record<string, string>;
	enabled: boolean;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export function isHttpServer(config: McpServerConfig): config is McpHttpServerConfig {
	return "url" in config;
}

export interface McpToolSpec {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpSession {
	listTools(): Promise<McpToolSpec[]>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ content: LoomToolResult["content"]; isError?: boolean }>;
	close(): Promise<void>;
}
