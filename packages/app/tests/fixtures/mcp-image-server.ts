import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const data = (await readFile(new URL("../../../core/tests/fixtures/media/still.png", import.meta.url))).toString("base64");
const server = new McpServer({ name: "loom-image-fixture", version: "1.0.0" });
server.registerTool("image", { description: "Return a test image", inputSchema: {} }, async () => ({ content: [
	{ type: "text", text: "Image from MCP" },
	{ type: "image", data, mimeType: "image/png" },
] }));
await server.connect(new StdioServerTransport());
