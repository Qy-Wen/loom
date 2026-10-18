import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";

const image = (await readFile(new URL("../../../core/tests/fixtures/media/still.png", import.meta.url))).toString("base64");
const inputSchema = { type: "object" as const, properties: {} };
const outputSchema = { type: "object" as const, properties: { message: { type: "string" } }, required: ["message"] };

export const CONTRACT_TOOLS = ["structured", "invalid_schema", "required_task", "resources", "error", "wait", "inspect", "text_and_structured"];

/** Real protocol fixture shared by stdio and HTTP contracts. */
export function createMcpContractServer(mode: "normal" | "repeated-cursor" = "normal") {
	const server = new Server({ name: "loom-contract-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
	const calls: string[] = [];
	let waitStarted = false;
	let cancelled = false;
	server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
		if (mode === "repeated-cursor") return { tools: [], nextCursor: "repeated" };
		const tools: Tool[] = params?.cursor === undefined
			? [
				{ name: "structured", inputSchema, outputSchema },
				{ name: "invalid_schema", inputSchema, outputSchema },
				{ name: "required_task", inputSchema, execution: { taskSupport: "required" } },
			]
			: CONTRACT_TOOLS.slice(3).map((name) => ({ name, inputSchema }));
		return { tools, ...(params?.cursor === undefined ? { nextCursor: "second" } : {}) };
	});
	server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra): Promise<CallToolResult> => {
		calls.push(params.name);
		switch (params.name) {
			case "structured": return { content: [], structuredContent: { message: "Structured from MCP" } };
			case "invalid_schema": return { content: [], structuredContent: { message: 42 } };
			case "text_and_structured": return { content: [{ type: "text", text: "Server summary" }], structuredContent: { message: "Do not duplicate" } };
			case "resources": return { content: [
				{ type: "text", text: "Resources from MCP", annotations: { audience: ["assistant"] } },
				{ type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "Embedded note" } },
				{ type: "resource", resource: { uri: "file:///still.png", mimeType: "image/png", blob: image } },
				{ type: "resource_link", name: "Source", uri: "https://example.com/source", description: "Resource metadata" },
				{ type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
				{ type: "resource", resource: { uri: "file:///data.bin", mimeType: "application/octet-stream", blob: "YmluYXJ5" } },
			] };
			case "error": return params.arguments?.structuredOnly ? { content: [], structuredContent: { message: "Structured failure" }, isError: true } : { content: [
				{ type: "resource", resource: { uri: "file:///error.txt", text: "Login expired" } },
				{ type: "image", data: image, mimeType: "image/png" },
			], isError: true };
			case "wait": {
				waitStarted = true;
				await new Promise<void>((resolve) => {
					const abort = () => { cancelled = true; resolve(); };
					if (extra.signal.aborted) abort();
					else extra.signal.addEventListener("abort", abort, { once: true });
				});
				return { content: [{ type: "text", text: "Cancelled work must not become a result" }] };
			}
			case "inspect": return { content: [], structuredContent: { waitStarted, cancelled, calls } };
			default: throw new Error(`Unexpected tool ${params.name}`);
		}
	});
	return server;
}
