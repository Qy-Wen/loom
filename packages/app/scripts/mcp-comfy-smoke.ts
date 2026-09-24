import { resolve } from "node:path";
import { loadMcpConfigFile } from "../src/main/mcp/config.ts";
import { McpHost } from "../src/main/mcp/host.ts";

const root = resolve(import.meta.dirname, "../../..");
process.loadEnvFile(resolve(root, ".env"));
const configs = (await loadMcpConfigFile(resolve(root, "mcp.json"))).filter((config) => config.id === "comfy");
if (!configs[0]) throw new Error("mcp.json has no comfy server");
if (!process.env.COMFY_API_KEY?.trim()) throw new Error("COMFY_API_KEY is empty");

const host = new McpHost();
const tools = await host.connect(configs);
const names = tools.map((tool) => tool.name);
console.log("MCP tools:", names.join(", ") || "(none)");
const probe = tools.find((tool) => tool.name === "comfy__get_server_info") ?? tools.find((tool) => tool.name === "comfy__server_info");
if (!names.length) {
	await host.close();
	throw new Error("Comfy Cloud MCP connected with no tools");
}
if (probe) {
	const result = await probe.execute({});
	console.log(String(result).slice(0, 500));
}
await host.close();
console.log("MCP Comfy Cloud smoke: ok");
