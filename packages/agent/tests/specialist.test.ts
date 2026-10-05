import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { HarnessSessionManager } from "../src/harness-session-manager.ts";
import { partitionLibraryTools, specialistUserMessage } from "../src/specialist.ts";
import type { LoomTool } from "../src/types.ts";

function tool(name: string): LoomTool {
	return {
		name,
		description: name,
		parameters: Type.Object({}),
		execute: () => name,
	};
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function stop(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function toolNames(body: string): string[] {
	const tools = (JSON.parse(body) as { tools?: Array<{ name?: string; function?: { name?: string } }> }).tools ?? [];
	return tools.map((entry) => entry.function?.name ?? entry.name ?? "").filter((name) => name.length > 0);
}

describe("specialists", () => {
	it("keeps search and MCP off the parent tool list", () => {
		const split = partitionLibraryTools([
			tool("search_assets"),
			tool("inspect_asset"),
			tool("describe_image"),
			tool("comfy__generate"),
			tool("run_retrieve_agent"),
		]);
		assert.deepEqual(split.parent.map((entry) => entry.name), ["describe_image"]);
		assert.deepEqual(split.retrieve.map((entry) => entry.name), ["search_assets", "inspect_asset"]);
		assert.deepEqual(split.create.map((entry) => entry.name), ["comfy__generate"]);
	});

	it("gives a specialist only the task string", () => {
		assert.equal(specialistUserMessage("  find the dock  "), "Task:\nfind the dock");
	});

	it("runs independent retrieve calls together and leaves the child transcript out of the session", async () => {
		let inflight = 0;
		let maxInflight = 0;
		let releaseChildren: () => void = () => undefined;
		const bothChildren = new Promise<void>((resolve) => { releaseChildren = resolve; });
		const childMessages: unknown[][] = [];
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => { body += chunk; });
			request.on("end", () => {
				void (async () => {
					const names = toolNames(body);
					const messages = (JSON.parse(body) as { messages?: unknown[] }).messages ?? [];
					response.writeHead(200, { "content-type": "text/event-stream" });
					if (names.includes("run_retrieve_agent") && !JSON.stringify(messages).includes("tool")) {
						response.write('data: {"id":"parent","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-a","type":"function","function":{"name":"run_retrieve_agent","arguments":"{\\"goal\\":\\"find alpha\\"}"}},{"index":1,"id":"call-b","type":"function","function":{"name":"run_retrieve_agent","arguments":"{\\"goal\\":\\"find beta\\"}"}}]},"finish_reason":null}]}\n\n');
						response.write('data: {"id":"parent","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
						response.end("data: [DONE]\n\n");
						return;
					}
					if (names.includes("search_assets")) {
						childMessages.push(messages);
						inflight += 1;
						maxInflight = Math.max(maxInflight, inflight);
						if (inflight === 2) releaseChildren();
						await Promise.race([
							bothChildren,
							new Promise((resolve) => setTimeout(resolve, 3000)),
						]);
						inflight -= 1;
						response.write('data: {"id":"child","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"asset_id: alpha"},"finish_reason":null}]}\n\n');
						response.write('data: {"id":"child","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
						response.end("data: [DONE]\n\n");
						return;
					}
					response.write('data: {"id":"done","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{"role":"assistant","content":"both found"},"finish_reason":null}]}\n\n');
					response.write('data: {"id":"done","object":"chat.completion.chunk","created":0,"model":"demo","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
					response.end("data: [DONE]\n\n");
				})();
			});
		});
		const baseUrl = await listen(server);
		const root = await mkdtemp(join(tmpdir(), "loom-specialist-"));
		const manager = new HarnessSessionManager({
			chat: { baseUrl, apiKey: "test", model: "demo" },
			tools: [tool("search_assets"), tool("inspect_asset"), tool("describe_image"), tool("comfy__generate")],
		});
		manager.setPermissionLevel("full");
		try {
			await manager.openLibrary(root);
			const session = await manager.createSession();
			await manager.prompt(session.id, "find two things");
			assert.equal(maxInflight, 2);
			assert.equal(childMessages.length, 2);
			for (const messages of childMessages) {
				assert.equal(messages.length, 2);
				assert.match(JSON.stringify(messages), /Task:\\nfind (alpha|beta)/);
				assert.doesNotMatch(JSON.stringify(messages), /find two things/);
			}
			const stored = await manager.getSession(session.id);
			assert.equal((await manager.listSessions()).length, 1);
			assert.doesNotMatch(JSON.stringify(stored.messages), /search_assets/);
			assert.match(JSON.stringify(stored.messages), /run_retrieve_agent/);
		} finally {
			await manager.close();
			await rm(root, { recursive: true, force: true });
			await stop(server);
		}
	});
});
