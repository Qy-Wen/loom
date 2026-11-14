import type { LoomToolResult } from "../types.ts";

/** Business data is independent of Durable UI details and MCP/HTTP envelopes. */
export function jsonToolResult<T>(data: T, space?: number): LoomToolResult<T> {
	return { content: JSON.stringify(data, null, space), data };
}
