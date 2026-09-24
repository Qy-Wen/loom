export interface McpStdioServerConfig {
	id: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

export interface McpHttpServerConfig {
	id: string;
	url: string;
	headers?: Record<string, string>;
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
	callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
	close(): Promise<void>;
}
