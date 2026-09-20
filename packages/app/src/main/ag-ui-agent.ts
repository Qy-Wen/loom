/**
 * AgUiAdapter — the single coupling point between Loom's agent and AG-UI.
 *
 * Wraps `@loom/agent` (LoomAgent) as an AG-UI `AbstractAgent`, so CopilotKit's
 * runtime can drive it. Translates `LoomAgentEvent` → AG-UI `BaseEvent`
 * (see AGENT.md §5.2). `LoomAgentEvent` never leaves this file.
 */
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { type BaseEvent, EventType } from "@ag-ui/core";
import {
	createLoomAgent,
	type LoomAgent as LoomAgentInstance,
	type LoomAgentOptions,
} from "@loom/agent";
import { Observable } from "rxjs";

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${idCounter++}`;

/** Pull the latest user text out of the AG-UI run input. */
function latestUserText(input: RunAgentInput): string {
	for (let i = input.messages.length - 1; i >= 0; i--) {
		const m = input.messages[i];
		if (m.role === "user") {
			return typeof m.content === "string"
				? m.content
				: (m.content ?? []).map((p) => ("text" in p ? p.text : "")).join("");
		}
	}
	return "";
}

export class LoomAgUiAgent extends AbstractAgent {
	private agentOptions: LoomAgentOptions;
	private sessions = new Map<string, LoomAgentInstance>();

	constructor(options: LoomAgentOptions) {
		super({ agentId: "loom" });
		this.agentOptions = options;
	}

	// CopilotKit's runner clones the registered agent per run; the base clone()
	// only copies known base fields, so carry our own config across (mirrors
	// how HttpAgent.clone() preserves url/headers).
	override clone(): this {
		const cloned = super.clone() as this;
		cloned.agentOptions = this.agentOptions;
		cloned.sessions = this.sessions;
		return cloned;
	}

	run(input: RunAgentInput): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			const emit = (event: BaseEvent) => subscriber.next(event);

			let loom = this.sessions.get(input.threadId);
			if (!loom) {
				loom = createLoomAgent(this.agentOptions);
				this.sessions.set(input.threadId, loom);
			}

			// One assistant text message per run; open lazily on first text delta.
			const messageId = nextId("msg");
			let textOpen = false;
			// Map tool invocations to AG-UI tool-call ids.
			const toolCallIds = new Map<string, string>();

			const openText = () => {
				if (textOpen) return;
				textOpen = true;
				emit({
					type: EventType.TEXT_MESSAGE_START,
					messageId,
					role: "assistant",
				} as BaseEvent);
			};
			const closeText = () => {
				if (!textOpen) return;
				textOpen = false;
				emit({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
			};

			const unsubscribe = loom.subscribe((event) => {
				switch (event.type) {
					case "agent_start":
						emit({
							type: EventType.RUN_STARTED,
							threadId: input.threadId,
							runId: input.runId,
						} as BaseEvent);
						break;

					case "text":
						openText();
						emit({
							type: EventType.TEXT_MESSAGE_CONTENT,
							messageId,
							delta: event.delta,
						} as BaseEvent);
						break;

					case "tool_start": {
						closeText();
						const toolCallId = nextId("tool");
						toolCallIds.set(event.name, toolCallId);
						emit({
							type: EventType.TOOL_CALL_START,
							toolCallId,
							toolCallName: event.name,
						} as BaseEvent);
						emit({
							type: EventType.TOOL_CALL_ARGS,
							toolCallId,
							delta: JSON.stringify(event.args ?? {}),
						} as BaseEvent);
						break;
					}

					case "tool_end": {
						const toolCallId = toolCallIds.get(event.name);
						if (toolCallId) {
							emit({
								type: EventType.TOOL_CALL_END,
								toolCallId,
							} as BaseEvent);
						}
						// v1: `details` rich output ignored (see AGENT.md §5.3b).
						break;
					}

					case "agent_end":
						closeText();
						emit({
							type: EventType.RUN_FINISHED,
							threadId: input.threadId,
							runId: input.runId,
						} as BaseEvent);
						break;
				}
			});

			loom
				.prompt(latestUserText(input))
				.then(() => subscriber.complete())
				.catch((err) => {
					closeText();
					emit({
						type: EventType.RUN_ERROR,
						message: err instanceof Error ? err.message : String(err),
					} as BaseEvent);
					subscriber.error(err);
				});

			return () => unsubscribe();
		});
	}
}
