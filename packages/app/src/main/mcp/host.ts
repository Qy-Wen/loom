import { existsSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LoomTool } from "@loom/agent";
import { isHttpServer, type McpServerConfig, type McpSession } from "./types.ts";
import { toolsFromMcpSession } from "./tools.ts";

export type McpSessionFactory = (config: McpServerConfig) => Promise<McpSession>;

export class McpHost {
	private readonly sessions: { config: McpServerConfig; session: McpSession }[] = [];
	private readonly openSession: McpSessionFactory;

	constructor(openSession: McpSessionFactory = openSdkSession) {
		this.openSession = openSession;
	}

	async connect(configs: McpServerConfig[]): Promise<LoomTool[]> {
		const tools: LoomTool[] = [];
		for (const config of configs) {
			try {
				const session = await this.openSession(config);
				const specs = await session.listTools();
				this.sessions.push({ config, session });
				tools.push(...toolsFromMcpSession(config.id, session, specs));
				console.log(`MCP ${config.id}: ${specs.map((spec) => spec.name).join(", ") || "(no tools)"}`);
			} catch (error) {
				console.error(`Failed to connect MCP server ${config.id}`, error);
			}
		}
		return tools;
	}

	async close(): Promise<void> {
		const closing = this.sessions.splice(0).map(({ session }) => session.close());
		await Promise.allSettled(closing);
	}
}

export async function openSdkSession(config: McpServerConfig): Promise<McpSession> {
	const client = new Client({ name: "loom", version: "0.0.0" });
	if (isHttpServer(config)) {
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			requestInit: config.headers ? { headers: config.headers } : undefined,
		});
		await client.connect(transport);
	} else {
		const launch = stdioLaunch(config);
		const transport = new StdioClientTransport({
			command: launch.command,
			args: launch.args,
			cwd: config.cwd,
			env: {
				...getDefaultEnvironment(),
				...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
				...config.env,
			},
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk) => {
			const text = String(chunk).trimEnd();
			if (text) console.error(`MCP ${config.id}:`, text);
		});
		await client.connect(transport);
	}
	return {
		async listTools() {
			const listed = await client.listTools();
			return listed.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}));
		},
		async callTool(name, args) {
			const result = await client.callTool({ name, arguments: args });
			return {
				content: flattenMcpContent(result.content),
				isError: result.isError === true,
			};
		},
		async close() {
			await client.close();
		},
	};
}

/** Windows `spawn({ shell: false })` cannot execute `.cmd` shims; prefer the Node CLI they wrap. */
export function stdioLaunch(
	config: { command: string; args?: string[] },
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): { command: string; args?: string[] } {
	const command = resolveStdioCommand(config.command, env, platform);
	if (platform === "win32") {
		const rewritten = rewriteWindowsNodeShim(command, config.args);
		if (rewritten) return rewritten;
	}
	return { command, args: config.args };
}

function rewriteWindowsNodeShim(command: string, args?: string[]): { command: string; args: string[] } | undefined {
	if (!/\.(cmd|bat)$/i.test(command)) return undefined;
	const dir = dirname(command);
	const name = basename(command).replace(/\.(cmd|bat)$/i, "").toLowerCase();
	const node = join(dir, "node.exe");
	const cli =
		name === "npx"
			? join(dir, "node_modules/npm/bin/npx-cli.js")
			: name === "npm"
				? join(dir, "node_modules/npm/bin/npm-cli.js")
				: undefined;
	if (!cli || !existsSync(node) || !existsSync(cli)) return undefined;
	return { command: node, args: [cli, ...(args ?? [])] };
}

/** Windows spawn cannot run PATHEXT shims like `npx` unless the `.cmd` path is resolved. */
export function resolveStdioCommand(
	command: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return command;
	if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return command;
	const exts = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter);
	for (const dir of dirs) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, `${command}${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	return command;
}

function flattenMcpContent(content: unknown): string {
	if (!Array.isArray(content)) return content == null ? "" : String(content);
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return String(part);
			const record = part as { type?: string; text?: string; mimeType?: string };
			if (record.type === "text") return record.text ?? "";
			if (record.type === "image") return `[image ${record.mimeType ?? "unknown"}]`;
			return JSON.stringify(part);
		})
		.filter(Boolean)
		.join("\n");
}
