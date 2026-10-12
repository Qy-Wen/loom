/**
 * Local Core HTTP server — hosts the CopilotKit runtime on a random localhost
 * port (see AGENT.md §6.1). The renderer connects to it via `runtimeUrl`.
 *
 * Standard hardening: bind 127.0.0.1 only, random free port (`listen(0)`),
 * closed on app quit.
 */
import { createServer, type Server } from "node:http";
import type { AssetRefAttachment, ComposerImageInput, UiSelectionFields } from "@loom/agent";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotNodeListener } from "@copilotkit/runtime/v2/node";
import type { LibraryAgentHost } from "./library-agent-host.ts";
import { LoomAgUiAgent } from "./ag-ui-agent.ts";
import { DurableAgentRunner } from "./durable-agent-runner.ts";

export interface AgentServer {
	/** e.g. http://127.0.0.1:53421/api/copilotkit */
	runtimeUrl: string;
	/** The agentId the frontend must target. */
	agentId: string;
	close: () => Promise<void>;
}

const ENDPOINT = "/api/copilotkit";
const AGENT_ID = "loom";

export async function startAgentServer(
	manager: LibraryAgentHost,
	getUiSelection?: () => UiSelectionFields | null,
	takeComposerImages?: (sessionId: string) => Promise<ComposerImageInput[]>,
	takeComposerAssets?: (sessionId: string) => Promise<AssetRefAttachment[]>,
): Promise<AgentServer> {
	// Local-first: opt out of CopilotKit's runtime telemetry.
	process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";

	const agent = new LoomAgUiAgent(manager, getUiSelection, takeComposerImages, takeComposerAssets);
	const runtime = new CopilotRuntime({
		agents: { [AGENT_ID]: agent },
		runner: new DurableAgentRunner(manager, agent),
	});

	const listener = createCopilotNodeListener({ runtime, basePath: ENDPOINT });

	const server: Server = createServer((req, res) => {
		// Production renderer (`file://`) has the opaque `null` origin; Vite dev
		// uses localhost. Permit only those origins, not arbitrary web pages.
		const origin = req.headers.origin;
		const rendererOriginAllowed =
			origin === "null" ||
			(origin !== undefined && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
		if (origin && rendererOriginAllowed) {
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Vary", "Origin");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
			res.setHeader(
				"Access-Control-Allow-Headers",
				req.headers["access-control-request-headers"] ?? "Content-Type, Authorization",
			);
		}
		if (req.method === "OPTIONS") {
			res.writeHead(rendererOriginAllowed ? 204 : 403).end();
			return;
		}
		void listener(req, res);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});

	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Failed to acquire a TCP port for the agent server");
	}

	return {
		runtimeUrl: `http://127.0.0.1:${address.port}${ENDPOINT}`,
		agentId: AGENT_ID,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}
