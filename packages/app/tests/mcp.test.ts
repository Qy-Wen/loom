import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expandEnv, parseMcpConfig } from "../src/main/mcp/config.ts";
import { McpHost, resolveStdioCommand, stdioLaunch } from "../src/main/mcp/host.ts";
import { mcpToolName, toolsFromMcpSession } from "../src/main/mcp/tools.ts";
import type { McpSession } from "../src/main/mcp/types.ts";

describe("MCP config", () => {
	it("parses servers array and Claude-style mcpServers", () => {
		const env = { TOKEN: "secret", HOME: "/tmp" };
		assert.deepEqual(
			parseMcpConfig({
				servers: [
					{ id: "local", command: "npx", args: ["-y", "demo"], env: { KEY: "${TOKEN}" } },
					{ id: "cloud", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
				],
			}, env),
			[
				{ id: "local", command: "npx", args: ["-y", "demo"], env: { KEY: "secret" }, cwd: undefined },
				{ id: "cloud", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" } },
			],
		);
		const claude = parseMcpConfig({
			mcpServers: { fs: { command: "uvx", args: ["mcp-server-fetch"], cwd: "${HOME}/src" } },
		}, env)[0];
		assert.ok(claude && "command" in claude);
		assert.equal(claude.cwd, "/tmp/src");
	});

	it("rejects entries without command or url", () => {
		assert.throws(() => parseMcpConfig({ servers: [{ id: "x" }] }), /command or url/);
		assert.equal(expandEnv("x${MISSING}y", {}), "xy");
	});
});

describe("MCP tools", () => {
	it("prefixes names and calls the original MCP tool", async () => {
		const calls: { name: string; args: Record<string, unknown> }[] = [];
		const session: McpSession = {
			listTools: async () => [{ name: "echo", description: "Repeat", inputSchema: { type: "object" } }],
			callTool: async (name, args) => {
				calls.push({ name, args });
				return { content: `ok:${name}` };
			},
			close: async () => undefined,
		};
		const tools = toolsFromMcpSession("Git Hub", session, await session.listTools());
		assert.equal(mcpToolName("Git Hub", "echo"), "Git_Hub__echo");
		assert.equal(tools[0]?.name, "Git_Hub__echo");
		assert.match(tools[0]?.description ?? "", /\[MCP:Git Hub\]/);
		assert.equal(await tools[0]?.execute({ text: "hi" }), "ok:echo");
		assert.deepEqual(calls, [{ name: "echo", args: { text: "hi" } }]);
	});

	it("surfaces MCP isError as a thrown failure", async () => {
		const session: McpSession = {
			listTools: async () => [],
			callTool: async () => ({ content: "boom", isError: true }),
			close: async () => undefined,
		};
		const [tool] = toolsFromMcpSession("demo", session, [{ name: "fail" }]);
		assert.ok(tool);
		await assert.rejects(async () => {
			await tool.execute({});
		}, /boom/);
	});
});

describe("resolveStdioCommand", () => {
	it("resolves Windows PATHEXT shims from PATH", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-mcp-"));
		await writeFile(join(dir, "npx.CMD"), "");
		assert.equal(
			resolveStdioCommand("npx", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32"),
			join(dir, "npx.CMD"),
		);
		assert.equal(resolveStdioCommand("npx", { PATH: dir }, "linux"), "npx");
	});

	it("rewrites Windows npx.cmd to node plus npx-cli.js", async () => {
		const dir = await mkdtemp(join(tmpdir(), "loom-mcp-"));
		const cli = join(dir, "node_modules/npm/bin/npx-cli.js");
		await mkdir(join(dir, "node_modules/npm/bin"), { recursive: true });
		await writeFile(join(dir, "npx.CMD"), "");
		await writeFile(join(dir, "node.exe"), "");
		await writeFile(cli, "");
		assert.deepEqual(
			stdioLaunch({ command: "npx", args: ["-y", "demo"] }, { PATH: dir, PATHEXT: ".CMD" }, "win32"),
			{ command: join(dir, "node.exe"), args: [cli, "-y", "demo"] },
		);
	});
});

describe("McpHost", () => {
	it("loads tools from healthy servers and skips broken ones", async () => {
		const host = new McpHost(async (config) => {
			if (config.id === "bad") throw new Error("offline");
			return {
				listTools: async () => [{ name: "ping" }],
				callTool: async () => ({ content: "pong" }),
				close: async () => undefined,
			};
		});
		const tools = await host.connect([
			{ id: "good", command: "echo" },
			{ id: "bad", url: "https://example.invalid/mcp" },
		]);
		assert.deepEqual(tools.map((tool) => tool.name), ["good__ping"]);
		assert.equal(await tools[0]?.execute({}), "pong");
		await host.close();
	});
});
