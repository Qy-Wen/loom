import type { LoomTool } from "@loom/agent";
import type { McpSession } from "./types.ts";

export function mcpToolName(serverId: string, toolName: string): string {
	return `${sanitize(serverId)}__${sanitize(toolName)}`;
}

export function toolsFromMcpSession(serverId: string, session: McpSession, specs: { name: string; description?: string; inputSchema?: unknown }[]): LoomTool[] {
	return specs.map((spec) => ({
		name: mcpToolName(serverId, spec.name),
		description: spec.description?.trim()
			? `[MCP:${serverId}] ${spec.description}`
			: `MCP tool ${spec.name} from ${serverId}`,
		parameters: spec.inputSchema ?? { type: "object", properties: {} },
		execute: async (rawArgs) => {
			const args = asObject(rawArgs);
			const result = await session.callTool(spec.name, args);
			if (result.isError) throw new Error(result.content || `MCP tool ${spec.name} failed`);
			return result.content;
		},
	}));
}

function sanitize(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
	return cleaned || "mcp";
}

function asObject(value: unknown): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("MCP tool arguments must be an object");
	return value as Record<string, unknown>;
}
