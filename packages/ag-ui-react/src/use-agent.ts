import { useMemo, useSyncExternalStore } from "react";
import { randomUUID, type AbstractAgent, type Message, type RunAgentParameters, type State, type UserMessage } from "@ag-ui/client";

export interface AgentSnapshot {
	messages: readonly Message[];
	state: State;
	isRunning: boolean;
	error: string | null;
}

function agentStore(agent: AbstractAgent) {
	let error: string | null = null;
	let snapshot: AgentSnapshot;
	function getSnapshot(): AgentSnapshot {
		if (!snapshot || snapshot.messages !== agent.messages || snapshot.state !== agent.state || snapshot.isRunning !== agent.isRunning || snapshot.error !== error) {
			snapshot = { messages: agent.messages, state: agent.state, isRunning: agent.isRunning, error };
		}
		return snapshot;
	}
	function subscribe(notify: () => void): () => void {
		const subscription = agent.subscribe({
			onMessagesChanged: notify,
			onStateChanged: notify,
			onRunInitialized() { error = null; notify(); },
			onRunFinalized: notify,
			onRunErrorEvent({ event }) { error = event.message; notify(); },
			onRunFailed({ error: cause }) { if (cause.name !== "AbortError") error = cause.message; notify(); },
		});
		return () => subscription.unsubscribe();
	}
	async function run(parameters?: RunAgentParameters) {
		if (agent.isRunning) throw new Error("The agent is already running");
		return agent.runAgent(parameters);
	}
	async function send(content: UserMessage["content"], parameters?: RunAgentParameters) {
		if (agent.isRunning) throw new Error("The agent is already running");
		agent.addMessage({ id: randomUUID(), role: "user", content });
		return run(parameters);
	}
	return { getSnapshot, subscribe, run, send, stop: () => agent.abortRun() };
}

/** Use a stable AG-UI agent instance per conversation. The agent owns the protocol state. */
export function useAgent(agent: AbstractAgent) {
	const store = useMemo(() => agentStore(agent), [agent]);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	return { ...snapshot, run: store.run, send: store.send, stop: store.stop };
}
