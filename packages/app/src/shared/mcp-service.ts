export interface McpServiceSettings {
	enabled: boolean;
	port: number;
	/** Empty disables authentication. Only available through the trusted local preload API. */
	token: string;
}
export interface ExternalToolTask {
	id: string;
	client: string;
	library: string;
	tool: string;
	args: Record<string, unknown>;
	status: "running" | "completed" | "failed" | "cancelled";
	startedAt: number;
	finishedAt?: number;
	error?: string;
}
export interface McpServiceView extends McpServiceSettings {
	url: string;
	running: boolean;
	error?: string;
	tasks: ExternalToolTask[];
}
export function parseMcpServiceSettings(value: unknown): McpServiceSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP service settings");
	const { enabled, port, token } = value as Record<string, unknown>;
	if (typeof enabled !== "boolean" || typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("MCP port must be an integer from 1024 to 65535");
	if (typeof token !== "string" || token.trim().length > 512 || token.trim() !== "" && !/^[\x21-\x7e]+$/.test(token.trim())) throw new Error("Access token must be empty or contain up to 512 printable ASCII characters without spaces");
	return { enabled, port, token: token.trim() };
}
