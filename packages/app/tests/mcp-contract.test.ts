import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BACKGROUND_CONTEXT, toDurableTool, type ToolExecutionApi } from "@loom/agent/durable";
import { McpHost, openSdkSession } from "../src/main/mcp/host.ts";
import { toolsFromMcpSession } from "../src/main/mcp/tools.ts";
import type { McpServerConfig, McpSession } from "../src/main/mcp/types.ts";
import { CONTRACT_TOOLS, createMcpContractServer } from "./fixtures/mcp-contract-server.ts";

type Transport = "stdio" | "http";

async function fixture(kind: Transport, run: (config: McpServerConfig) => Promise<void>, mode: "normal" | "repeated-cursor" = "normal") {
	if (kind === "stdio") {
		await run({
			id: "fixture", enabled: true, command: process.execPath,
			args: ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/mcp-contract-stdio.ts", import.meta.url)), mode],
		});
		return;
	}
	const server = createMcpContractServer(mode);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
	await server.connect(transport);
	const http = createServer((request, response) => {
		if (request.headers.authorization !== "Bearer fixture-token") { response.writeHead(401).end(); return; }
		void transport.handleRequest(request, response).catch(() => { response.destroy(); });
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	try {
		await run({ id: "fixture", enabled: true, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, headers: { Authorization: "Bearer fixture-token" } });
	} finally {
		await server.close();
		http.closeAllConnections();
		await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
	}
}

async function withSession(kind: Transport, run: (session: McpSession) => Promise<void>) {
	await fixture(kind, async (config) => {
		const session = await openSdkSession(config);
		try { await run(session); } finally { await session.close(); }
	});
}

async function until(predicate: () => Promise<boolean>) {
	for (let count = 0; count < 100; count++) {
		if (await predicate()) return;
		await delay(10);
	}
	assert.fail("MCP fixture did not reach the expected state");
}

for (const kind of ["stdio", "http"] as const) describe(`MCP ${kind} contract`, { timeout: 15_000 }, () => {
	it("discovers all pages and retains first-page schema validation and task requirements", async () => {
		await withSession(kind, async (session) => {
			assert.deepEqual((await session.listTools()).map((tool) => tool.name), CONTRACT_TOOLS);
			assert.deepEqual((await session.callTool("structured", {})).structuredContent, { message: "Structured from MCP" });
			await assert.rejects(session.callTool("invalid_schema", {}), /Structured content does not match/);
			await assert.rejects(session.callTool("required_task", {}), /requires task-based execution/);
			const state = (await session.callTool("inspect", {})).structuredContent as { calls: string[] };
			assert.equal(state.calls.includes("required_task"), false);
		});
	});

	it("maps structured and embedded results through the durable adapter without changing other blocks", async () => {
		await withSession(kind, async (session) => {
			const specs = await session.listTools();
			const tools = toolsFromMcpSession("fixture", session, specs);
			const output = async (name: string) => {
				const tool = tools.find((tool) => tool.name === `fixture__${name}`)!;
				const result = await toDurableTool(tool).execute({}, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
				assert.ok(result.output);
				return result.output;
			};
			assert.deepEqual(await output("structured"), [{ type: "text", text: JSON.stringify({ message: "Structured from MCP" }, null, 2) }]);
			assert.deepEqual(await output("text_and_structured"), [{ type: "text", text: "Server summary" }]);
			const raw = await session.callTool("resources", {});
			assert.ok(Array.isArray(raw.content));
			assert.deepEqual(raw.content[0], { type: "text", text: "Resources from MCP", annotations: { audience: ["assistant"] } });
			const parts = await output("resources");
			assert.deepEqual(parts.slice(0, 2), [{ type: "text", text: "Resources from MCP" }, { type: "text", text: "Embedded note" }]);
			const resource = raw.content[2] as { resource: { blob: string; mimeType: string } };
			assert.deepEqual(parts[2], { type: "image", data: resource.resource.blob, mimeType: "image/png" });
			assert.deepEqual(parts.slice(3), raw.content.slice(3).map((part) => ({ type: "text", text: JSON.stringify(part) })));
		});
	});

	it("reports isError using readable text without including image bytes", async () => {
		await withSession(kind, async (session) => {
			const tools = toolsFromMcpSession("fixture", session, await session.listTools());
			await assert.rejects(async () => tools.find((tool) => tool.name === "fixture__error")!.execute({}), { message: "Login expired" });
			await assert.rejects(async () => tools.find((tool) => tool.name === "fixture__error")!.execute({ structuredOnly: true }), { message: JSON.stringify({ message: "Structured failure" }, null, 2) });
		});
	});

	it("does not dispatch pre-aborted calls and cancels in-flight work without closing the session", async () => {
		await withSession(kind, async (session) => {
			const tools = toolsFromMcpSession("fixture", session, await session.listTools());
			const wait = tools.find((tool) => tool.name === "fixture__wait")!;
			const state = async () => (await session.callTool("inspect", {})).structuredContent as { waitStarted: boolean; cancelled: boolean; calls: string[] };
			const stopped = new AbortController(); stopped.abort(new Error("Stopped before dispatch"));
			await assert.rejects(async () => wait.execute({}, stopped.signal), /Stopped before dispatch/);
			assert.equal((await state()).calls.includes("wait"), false);
			const controller = new AbortController();
			const rejected = assert.rejects(async () => wait.execute({}, controller.signal), /Stop MCP work/);
			await until(async () => (await state()).waitStarted);
			controller.abort(new Error("Stop MCP work"));
			await rejected;
			await until(async () => (await state()).cancelled);
			assert.deepEqual((await session.callTool("structured", {})).structuredContent, { message: "Structured from MCP" });
		});
	});

	it("rejects repeated cursors instead of returning a partial tool list", async () => {
		await fixture(kind, async (config) => {
			const host = new McpHost();
			try {
				assert.deepEqual(await host.connect([config]), []);
				assert.match(host.lastStatus()[0]?.error ?? "", /repeated a pagination cursor/);
			} finally { await host.close(); }
		}, "repeated-cursor");
	});
});
