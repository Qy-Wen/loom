import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

const MAX_TOOL_PAGES = 1_000;

/** Aggregate before Client.listTools() caches output schemas and task requirements. */
export class McpClient extends Client {
	override request: Client["request"] = async (request, schema, options) => {
		const first = await super.request(request, schema, options);
		if (request.method !== "tools/list") return first;
		let page = first as ListToolsResult;
		const tools = [...page.tools];
		const seen = new Set<string>();
		if (typeof request.params?.cursor === "string") seen.add(request.params.cursor);
		for (let count = 1; page.nextCursor; count++) {
			if (seen.has(page.nextCursor)) throw new Error("MCP tools/list repeated a pagination cursor");
			if (count >= MAX_TOOL_PAGES) throw new Error("MCP tools/list exceeded the page limit");
			seen.add(page.nextCursor);
			page = await super.request({ ...request, params: { ...request.params, cursor: page.nextCursor } }, schema, options) as ListToolsResult;
			tools.push(...page.tools);
		}
		return { ...first, tools, nextCursor: undefined };
	};
}
