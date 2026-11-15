import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutor, ToolLibraryBinding, LoomToolResult } from "@loom/agent/tools";
import type { ExternalToolTask } from "../../shared/mcp-service.ts";
import { toolAnnotations } from "./tool-annotations.ts";

interface Session {
	server: McpServer;
	transport: StreamableHTTPServerTransport;
	controller: AbortController;
	library: ToolLibraryBinding;
	root: string;
	touched: number;
	running: Set<Promise<unknown>>;
}
export interface McpServiceHost {
	executor: ToolExecutor;
	bindLibrary(): Promise<{ library: ToolLibraryBinding; root: string }>;
	onTasks(tasks: ExternalToolTask[]): void;
}

/** Local, stateful Streamable HTTP adapter. No Electron or conversation dependencies. */
export async function startMcpService(host: McpServiceHost, options: { port: number; token: string }) {
	const sessions = new Set<Session>();
	const tasks = new Map<string, { view: ExternalToolTask; controller: AbortController }>();
	const running = new Set<Promise<unknown>>();
	let initializing = 0;
	let closed = false;
	const publish = () => host.onTasks([...tasks.values()].map(({ view }) => structuredClone(view)).reverse());
	const expire = async (session: Session) => {
		sessions.delete(session);
		session.controller.abort();
		await Promise.allSettled([...session.running]);
		// Let the SDK flush cancellation results before closing the response streams.
		await nextTurn();
		await session.server.close();
	};
	const createSession = async (): Promise<Session> => {
		const bound = await host.bindLibrary();
		if (closed) throw new Error("MCP service is stopping");
		const server = new McpServer({ name: "loom", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Library tools operate on the Loom library bound to this connection. Use get_library first. Reconnect after switching libraries. get_settings and update_settings operate on app-wide configuration shared by all libraries; external clients manage tool approvals. Files use asset IDs; media paths must stay inside the library. inspect_asset preview references are replaced by read_asset. Mutations are not automatically retried; inspect the library and Loom call history if a connection is interrupted." });
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, maxRequestBodySize: 1024 * 1024, onsessionclosed: () => expire(session) });
		const session: Session = { ...bound, server, transport, controller: new AbortController(), touched: Date.now(), running: new Set() };
		// Custom protocol handlers keep schemas and validation in the shared tool catalog/executor.
		const protocol = server.server;
		protocol.setRequestHandler(ListToolsRequestSchema, async () => {
			await session.library.run(async () => {});
			return { tools: host.executor.catalog.list("external").map(({ tool }) => ({ name: tool.name, description: tool.description + (["run_ffmpeg", "run_ffprobe", "grade_image"].includes(tool.name) ? " External access: visible library-relative file paths only. Outputs must be new single media files; no overwrite, protocols, playlists, file-loading filters, or arbitrary FFmpeg options. Simple scale/crop/fps/rotate/color/audio filters are supported through -vf/-af." : ""), inputSchema: tool.parameters as Tool["inputSchema"], annotations: toolAnnotations(tool.name) })) };
		});
		protocol.setRequestHandler(CallToolRequestSchema, async ({ params }, extra): Promise<CallToolResult> => {
			if ([...tasks.values()].filter(({ view }) => !view.finishedAt).length >= 16) throw new Error("Too many active tool calls");
			const controller = new AbortController();
			const signal = AbortSignal.any([controller.signal, extra.signal, session.controller.signal]);
			const view: ExternalToolTask = { id: `external-${randomUUID()}`, client: protocol.getClientVersion()?.name.slice(0, 120) ?? "MCP client", library: session.root, tool: params.name, args: params.arguments ?? {}, status: "running", startedAt: Date.now() };
			tasks.set(view.id, { view, controller });
			for (const [id, task] of tasks) { if (tasks.size <= 100) break; if (task.view.finishedAt) tasks.delete(id); }
			publish();
			const progressToken = params._meta?.progressToken;
			const progress = async (progress: number, message: string) => { if (progressToken !== undefined && !signal.aborted) await extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, total: 1, message } }).catch(() => {}); };
			const work = (async () => {
				try {
					await progress(0, "Running in Loom");
					const result = await host.executor.execute(params.name, params.arguments, {
						audience: "external", library: session.library, signal,
					});
					view.status = "completed";
					await progress(1, "Completed");
					return encodeMcpResult(params.name, result);
				} catch (error) {
					view.status = signal.aborted ? "cancelled" : "failed";
					view.error = signal.aborted ? "Cancelled; check the library for any changes already completed." : error instanceof Error ? error.message : String(error);
					return { isError: true, content: [{ type: "text" as const, text: view.error }] };
				} finally { view.finishedAt = Date.now(); publish(); }
			})();
			running.add(work);
			session.running.add(work);
			try { return await work; } finally { running.delete(work); session.running.delete(work); }
		});
		await server.connect(transport);
		if (closed) { await server.close(); throw new Error("MCP service is stopping"); }
		sessions.add(session);
		return session;
	};
	const http = createServer((request, response) => { void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500).end("MCP request failed"); else response.end(); }); });
	async function handle(request: IncomingMessage, response: ServerResponse) {
		response.setHeader("Cache-Control", "no-store");
		if (closed) { response.writeHead(503).end(); return; }
		const hostHeader = request.headers.host;
		if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) { response.writeHead(403).end("Invalid Host"); return; }
		if (request.headers.origin !== undefined && request.headers.origin !== `http://${hostHeader}`) { response.writeHead(403).end("Invalid Origin"); return; }
		if (options.token) {
			const authorization = Buffer.from(request.headers.authorization ?? "");
			const expected = Buffer.from(`Bearer ${options.token}`);
			if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { response.writeHead(401).end("Bearer token required"); return; }
		}
		if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
		const id = request.headers["mcp-session-id"];
		let session = [...sessions].find((row) => row.transport.sessionId === id);
		if (!session && id !== undefined) { response.writeHead(404).end("Session expired; reconnect to Loom"); return; }
		if (!session) {
			if (request.method !== "POST") { response.writeHead(400).end("Initialize a session first"); return; }
			// Parse initialization before allocating a library binding or a transport.
			const chunks: Buffer[] = []; let size = 0;
			for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
			let body: unknown;
			try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { response.writeHead(400).end("Invalid JSON"); return; }
			if (!isInitializeRequest(body)) { response.writeHead(400).end("Initialize a session first"); return; }
			if (sessions.size + initializing >= 16) { response.writeHead(429).end("Too many sessions"); return; }
			initializing++;
			try {
				try { session = await createSession(); } catch { response.writeHead(409).end("Open a library in Loom first"); return; }
				await session.transport.handleRequest(request, response, body);
				if (!session.transport.sessionId) await expire(session);
			} finally { initializing--; }
			return;
		}
		session.touched = Date.now();
		await session.transport.handleRequest(request, response);
	}
	await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(options.port, "127.0.0.1", () => { http.removeListener("error", reject); resolve(); }); });
	const port = (http.address() as { port: number }).port;
	const timer = setInterval(() => { for (const session of sessions) if (Date.now() - session.touched > 30 * 60_000) void expire(session).catch(() => {}); }, 60_000);
	timer.unref();
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		cancel(id: string) { const task = tasks.get(id); if (!task || task.view.finishedAt) return false; task.controller.abort(); return true; },
		async invalidate() { await Promise.allSettled([...sessions].map(expire)); await Promise.allSettled([...running]); },
		async close() { closed = true; clearInterval(timer); await this.invalidate(); http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); },
	};
}

/** Only portable protocol content and business data leave Loom; UI details are deliberately ignored. */
export function encodeMcpResult(name: string, result: string | LoomToolResult): CallToolResult {
	if (typeof result === "string") return { content: [{ type: "text", text: result }] };
	let data = result.data;
	let content = result.content;
	if (name === "inspect_asset" && data && typeof data === "object" && !Array.isArray(data)) {
		const { previewRef: _preview, ...rest } = data as Record<string, unknown>;
		data = { ...rest, readTool: "read_asset" }; content = JSON.stringify(data);
	}
	const blocks: CallToolResult["content"] = typeof content === "string" ? [{ type: "text", text: content }] : content.flatMap<CallToolResult["content"][number]>((part) => {
		if (part.type === "text" && typeof part.text === "string") return [{ type: "text" as const, text: part.text }];
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return [{ type: "image" as const, data: part.data, mimeType: part.mimeType }];
		return [];
	});
	return { content: blocks, ...(data === undefined ? {} : { structuredContent: data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { result: data } }) };
}
