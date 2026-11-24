import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { useAgent } from "@loom/ag-ui-react";
import { adoptMessageId } from "../../shared/ag-ui-messages.ts";
import type { AgentEndpoint } from "../../shared/ipc.ts";

class LoomAgent extends HttpAgent {
	readonly #url: string;
	readonly #attachment: HttpAgent;
	#runId?: string;
	#stopRequested = false;

	constructor(endpoint: AgentEndpoint, threadId: string) {
		const headers = { Authorization: `Bearer ${endpoint.token}` };
		super({ url: `${endpoint.url}/run`, threadId, headers });
		this.#url = endpoint.url;
		this.#attachment = new HttpAgent({ url: `${endpoint.url}/connect`, threadId, headers });
	}

	override run(input: RunAgentInput) {
		// Durable owns model context. Only this turn's user input is sent to Loom.
		const user = input.messages.findLast((message) => message.role === "user");
		return super.run({ ...input, messages: user ? [user] : [] });
	}

	protected override connect(input: RunAgentInput) {
		return this.#attachment.run({ ...input, messages: [] });
	}

	override runAgent(...args: Parameters<HttpAgent["runAgent"]>) {
		this.#runId = undefined;
		this.#stopRequested = false;
		return super.runAgent(...args);
	}

	setRunId(runId: string) {
		this.#runId = runId;
		if (this.#stopRequested) return this.stop();
	}

	disconnect() {
		this.#attachment.abortRun();
		this.abortRun();
		void this.detachActiveRun();
	}

	async stop() {
		if (!this.#runId) {
			// The durable run has no stop scope until the server acknowledges it.
			this.#stopRequested = true;
			return;
		}
		this.#stopRequested = false;
		const response = await fetch(`${this.#url}/stop`, {
			method: "POST",
			headers: { ...this.headers, "Content-Type": "application/json" },
			body: JSON.stringify({ threadId: this.threadId, runId: this.#runId }),
		});
		if (!response.ok) throw new Error(`Could not stop the agent (HTTP ${response.status})`);
	}
}

/** Each mounted thread has its own transient stream. Detaching never stops durable work. */
export function useChatStream(endpoint: AgentEndpoint, threadId: string, onHistoryChanged: () => void) {
	const agent = useMemo(() => new LoomAgent(endpoint, threadId), [endpoint, threadId]);
	const stream = useAgent(agent);
	const [readyAgent, setReadyAgent] = useState<LoomAgent | null>(null);
	const [failure, setFailure] = useState<{ agent: LoomAgent; message: string } | null>(null);
	const onHistory = useRef(onHistoryChanged);
	onHistory.current = onHistoryChanged;
	const report = useCallback((cause: unknown) => {
		if (cause instanceof Error && cause.name === "AbortError") return;
		setFailure({ agent, message: cause instanceof Error ? cause.message : String(cause) });
	}, [agent]);

	useEffect(() => {
		let attached = true;
		const subscription = agent.subscribe({
			onRunInitialized() { setFailure(null); },
			onRunStartedEvent({ event }) { void agent.setRunId(event.runId)?.catch(report); },
			onRunErrorEvent() { onHistory.current(); },
			onMessagesSnapshotEvent({ event }) {
				return { messages: event.messages, stopPropagation: true };
			},
			onCustomEvent({ event, messages }) {
				if (event.name === "loom.connected") {
					if (event.value?.running === true) setReadyAgent(agent);
					return;
				}
				if (event.name === "loom.history_changed") {
					if (event.value?.threadId === threadId) onHistory.current();
					return;
				}
				if (event.name !== "loom.user_entry" && event.name !== "loom.adopt_entry") return;
				const { entryId, fromId } = event.value ?? {};
				if (typeof entryId !== "string" || typeof fromId !== "string") return;
				const next = adoptMessageId(messages, fromId, entryId);
				if (next) return { messages: next };
			},
		});
		// A discarded Strict Mode setup never starts a request.
		queueMicrotask(() => {
			if (!attached) return;
			void agent.connectAgent().catch((cause: unknown) => {
				if (attached) report(cause);
			}).finally(() => {
				if (attached) setReadyAgent(agent);
			});
		});
		return () => {
			attached = false;
			subscription.unsubscribe();
			if (agent.isRunning) agent.disconnect();
		};
	}, [agent, report, threadId]);

	const stop = useCallback(() => { void agent.stop().catch(report); }, [agent, report]);
	const connecting = readyAgent !== agent;
	return { messages: stream.messages, connecting, isRunning: stream.isRunning && !connecting, send: stream.send, stop, error: stream.error ?? (failure?.agent === agent ? failure.message : null) };
}
