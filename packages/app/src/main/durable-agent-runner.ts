import { AgentRunner, type AgentRunnerConnectRequest, type AgentRunnerIsRunningRequest, type AgentRunnerRunRequest, type AgentRunnerStopRequest } from "@copilotkit/runtime/v2";
import { share } from "rxjs";
import { BACKGROUND_CONTEXT as context } from "@loom/agent";
import { LoomAgUiAgent } from "./ag-ui-agent.ts";
import type { LibraryAgentHost } from "./library-agent-host.ts";

/** Transport routing only. Durable owns work, history and recovery, not CopilotKit's memory runner. */
export class DurableAgentRunner extends AgentRunner {
	readonly host: LibraryAgentHost;
	readonly adapter: LoomAgUiAgent;
	constructor(host: LibraryAgentHost, adapter: LoomAgUiAgent) { super(); this.host = host; this.adapter = adapter; }
	run(request: AgentRunnerRunRequest) {
		if (!(request.agent instanceof LoomAgUiAgent)) throw new Error("Expected the Loom AG-UI adapter");
		// A transport disconnect is not Stop. Keep observing until settlement;
		// reconnect reads durable snapshots and does not need a replay buffer.
		return request.agent.run(request.input).pipe(share({ resetOnRefCountZero: false }));
	}
	connect(request: AgentRunnerConnectRequest) { return this.adapter.connectThread(request.threadId); }
	async isRunning(request: AgentRunnerIsRunningRequest) {
		const conversation = await this.host.conversation(request.threadId);
		const inspection = await this.host.requireOwner().harness.inspect(context);
		return inspection.submissions.some((row) => row.conversationId === conversation.id && row.type === "input" && (row.status === "queued" || row.status === "placed"));
	}
	async stop(request: AgentRunnerStopRequest): Promise<boolean> {
		const conversation = await this.host.conversation(request.threadId);
		const inspection = await this.host.requireOwner().harness.inspect(context);
		const active = inspection.submissions.filter((row) => row.conversationId === conversation.id && row.type === "input" && (row.status === "queued" || row.status === "placed"));
		if (!active.length || (request.runId !== undefined && !active.some((row) => row.requestId === request.runId))) return false;
		await conversation.abort(context);
		return true;
	}
}
