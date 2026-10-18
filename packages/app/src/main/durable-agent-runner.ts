import { AgentRunner, type AgentRunnerConnectRequest, type AgentRunnerIsRunningRequest, type AgentRunnerRunRequest, type AgentRunnerStopRequest } from "@copilotkit/runtime/v2";
import { share } from "rxjs";
import { AgUiAdapter } from "./ag-ui-adapter.ts";
import type { ChatService } from "./chat-service.ts";

/** Transport routing only. Durable owns work, history and recovery, not CopilotKit's memory runner. */
export class DurableAgentRunner extends AgentRunner {
	readonly service: ChatService;
	readonly adapter: AgUiAdapter;
	constructor(service: ChatService, adapter: AgUiAdapter) { super(); this.service = service; this.adapter = adapter; }
	run(request: AgentRunnerRunRequest) {
		if (!(request.agent instanceof AgUiAdapter)) throw new Error("Expected the Loom AG-UI adapter");
		// A transport disconnect is not Stop. Keep observing until settlement;
		// reconnect reads durable snapshots and does not need a replay buffer.
		return request.agent.run(request.input).pipe(share({ resetOnRefCountZero: false }));
	}
	connect(request: AgentRunnerConnectRequest) { return this.adapter.connectThread(request.threadId); }
	isRunning(request: AgentRunnerIsRunningRequest) { return this.service.isRunning(request.threadId); }
	stop(request: AgentRunnerStopRequest): Promise<boolean> { return this.service.stop(request.threadId, request.runId); }
}
