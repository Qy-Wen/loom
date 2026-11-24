import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { share, type Observable } from "rxjs";
import { z } from "zod/v4";
import type { AgentEndpoint } from "../../shared/ipc.ts";
import { AgUiAdapter } from "./ag-ui-adapter.ts";
import type { ChatService } from "./chat-service.ts";

export interface AgentServer {
	endpoint: AgentEndpoint;
	close: () => Promise<void>;
}

const ENDPOINT = "/api/ag-ui";
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const threadInput = z.object({ threadId: z.string().min(1) });
const stopInput = threadInput.extend({ runId: z.string().min(1) });

class RequestError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readBody(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		bytes += chunk.length;
		if (bytes > MAX_BODY_BYTES) throw new RequestError(413, "Agent request is too large");
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new RequestError(400, "Expected a JSON body");
	}
}

function sendJson(res: ServerResponse, status: number, body: object): void {
	res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function sendEvents(res: ServerResponse, events: Observable<BaseEvent>): void {
	if (res.destroyed) return;
	res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
	res.flushHeaders();

	const subscription = events.subscribe({
		next(event) {
			res.write(`data: ${JSON.stringify(event)}\n\n`);
		},
		error() {
			res.end(`data: ${JSON.stringify({ type: EventType.RUN_ERROR, message: "Agent stream failed" })}\n\n`);
		},
		complete() { res.end(); },
	});
	res.once("close", () => subscription.unsubscribe());
}

export async function startAgentServer(service: ChatService, devRendererUrl?: string): Promise<AgentServer> {
	const agent = new AgUiAdapter(service);
	const token = randomBytes(32).toString("hex");
	const rendererOrigin = devRendererUrl ? new URL(devRendererUrl).origin : "null";

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const origin = req.headers.origin;
		res.setHeader("Vary", "Origin");
		if (origin !== undefined && origin !== rendererOrigin) {
			res.writeHead(403).end();
			return;
		}
		if (origin !== undefined) res.setHeader("Access-Control-Allow-Origin", origin);
		if (req.method === "OPTIONS") {
			res.writeHead(204, {
				"Access-Control-Allow-Methods": "POST",
				"Access-Control-Allow-Headers": "Content-Type, Authorization",
			}).end();
			return;
		}
		if (req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(401).end();
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST, OPTIONS" }).end();
			return;
		}

		switch (req.url) {
			case `${ENDPOINT}/run`: {
				const input = RunAgentInputSchema.safeParse(await readBody(req));
				if (!input.success || !input.data.threadId || !input.data.runId) throw new RequestError(400, "Invalid AG-UI run input");
				// Keep admitted work alive if the renderer drops its HTTP connection.
				sendEvents(res, agent.run(input.data).pipe(share({ resetOnRefCountZero: false })));
				return;
			}
			case `${ENDPOINT}/connect`: {
				const input = threadInput.safeParse(await readBody(req));
				if (!input.success) throw new RequestError(400, "Expected a thread ID");
				sendEvents(res, agent.connectThread(input.data.threadId));
				return;
			}
			case `${ENDPOINT}/stop`: {
				const input = stopInput.safeParse(await readBody(req));
				if (!input.success) throw new RequestError(400, "Expected thread and run IDs");
				sendJson(res, 200, { stopped: await service.stop(input.data.threadId, input.data.runId) });
				return;
			}
			default:
				res.writeHead(404).end();
		}
	}

	const server = createServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			if (res.destroyed) return;
			if (res.headersSent) {
				res.destroy();
				return;
			}
			if (error instanceof RequestError) {
				if (error.status === 413) res.setHeader("Connection", "close");
				sendJson(res, error.status, { error: error.message });
			} else {
				sendJson(res, 500, { error: "Agent request failed" });
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Agent server has no TCP port");
	return {
		endpoint: { url: `http://127.0.0.1:${address.port}${ENDPOINT}`, token },
		close: () => new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
			server.closeAllConnections();
		}),
	};
}
