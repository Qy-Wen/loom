/**
 * Typed IPC contract between Main and Renderer.
 *
 * v1 only needs one thing: hand the renderer the agent server's runtimeUrl +
 * agentId so CopilotKit can connect. The agent conversation itself flows over
 * HTTP/SSE (localhost server), not IPC.
 */

export interface AgentEndpoint {
	runtimeUrl: string;
	agentId: string;
}

export const IPC = {
	getAgentEndpoint: "loom:getAgentEndpoint",
} as const;

export interface LoomApi {
	getAgentEndpoint: () => Promise<AgentEndpoint>;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
