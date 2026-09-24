import { resolve } from "node:path";
import { loadMcpConfigFile } from "../src/main/mcp/config.ts";
import { McpHost } from "../src/main/mcp/host.ts";

const configs = await loadMcpConfigFile(resolve(import.meta.dirname, "../../../mcp.json"));
const host = new McpHost();
const tools = await host.connect(configs);
const names = tools.map((tool) => tool.name);
console.log("MCP tools:", names.join(", ") || "(none)");
const fetchTool = tools.find((tool) => tool.name === "fetch__fetch_markdown");
if (!fetchTool) {
	await host.close();
	throw new Error(`fetch__fetch_markdown missing; got: ${names.join(", ") || "(none)"}`);
}
const result = await fetchTool.execute({ url: "https://example.com", max_length: 800 });
console.log(String(result).slice(0, 400));
if (!String(result).includes("Example Domain")) {
	await host.close();
	throw new Error("fetch_markdown did not return Example Domain");
}
await host.close();
console.log("MCP fetch smoke: ok");
