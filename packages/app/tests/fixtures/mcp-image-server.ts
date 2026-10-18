import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const data = (await readFile(new URL("../../../core/tests/fixtures/media/still.png", import.meta.url))).toString("base64");
const server = new McpServer({ name: "loom-image-fixture", version: "1.0.0" });
server.registerTool("image", { description: "Return a test image", inputSchema: {} }, async () => ({ content: [
	{ type: "text", text: "Image from MCP" },
	{ type: "image", data, mimeType: "image/png" },
] }));
if (process.argv.includes("--embedded")) server.registerTool("embedded_image", { description: "Return an embedded test image", inputSchema: {} }, async () => ({ content: [
	{ type: "resource", resource: { uri: "file:///caption.txt", text: "Image from MCP", mimeType: "text/plain" } },
	{ type: "resource", resource: { uri: "file:///still.png", blob: data, mimeType: "image/png" } },
] }));
await server.connect(new StdioServerTransport());
