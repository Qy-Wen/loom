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
				{ id: "local", command: "npx", args: ["-y", "demo"], env: { KEY: "secret" }, cwd: undefined, enabled: true },
				{ id: "cloud", url: "https://example.com/mcp", headers: { Authorization: "Bearer secret" }, enabled: true },
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

	it("defaults enabled to true and keeps an explicit off switch", () => {
		assert.equal(parseMcpConfig({ servers: [{ id: "on", command: "echo" }] })[0]?.enabled, true);
		assert.equal(parseMcpConfig({ servers: [{ id: "off", command: "echo", enabled: false }] })[0]?.enabled, false);
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
			{ id: "good", command: "echo", enabled: true },
			{ id: "bad", url: "https://example.invalid/mcp", enabled: true },
			{ id: "off", command: "echo", enabled: false },
		]);
		assert.deepEqual(tools.map((tool) => tool.name), ["good__ping"]);
		assert.equal(await tools[0]?.execute({}), "pong");
		assert.deepEqual(host.lastStatus().map((row) => row.id), ["good", "bad"]);
		await host.close();
	});

	it("connects servers concurrently", async () => {
		const release: Array<() => void> = [];
		const host = new McpHost(async (config) => {
			await new Promise<void>((resolve) => {
				release.push(resolve);
			});
			return {
				listTools: async () => [{ name: config.id }],
				callTool: async () => ({ content: "" }),
				close: async () => undefined,
			};
		});
		const pending = host.connect([
			{ id: "a", command: "echo", enabled: true },
			{ id: "b", command: "echo", enabled: true },
		]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(release.length, 2);
		for (const done of release) done();
		const tools = await pending;
		assert.deepEqual(tools.map((tool) => tool.name).sort(), ["a__a", "b__b"]);
		await host.close();
	});

	it("upserts and drops a single server without reconnecting the rest", async () => {
		const closed: string[] = [];
		const host = new McpHost(async (config) => ({
			listTools: async () => [{ name: "ping" }],
			callTool: async () => ({ content: "pong" }),
			close: async () => {
				closed.push(config.id);
			},
		}));
		await host.connect([{ id: "keep", command: "echo", enabled: true }]);
		const extra = await host.upsertServer({ id: "extra", command: "echo", enabled: true });
		assert.deepEqual(extra.tools, ["ping"]);
		assert.deepEqual(host.allTools().map((tool) => tool.name).sort(), ["extra__ping", "keep__ping"]);
		await host.dropServer("extra");
		assert.deepEqual(closed, ["extra"]);
		assert.deepEqual(host.allTools().map((tool) => tool.name), ["keep__ping"]);
		await host.close();
	});
});
