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
	type LoomTool,
	type LoomTranscriptMessage,
} from "@loom/agent";
import { DEFAULT_SESSION_TITLE, titleFromUserText } from "@loom/core";
import { Observable } from "rxjs";

type LoomAgentFactory = (options: LoomAgentOptions) => LoomAgentInstance;

export interface AgentSessionStore {
	openSession(id: string): Promise<{ title: string; messages: LoomTranscriptMessage[] }>;
	appendSessionMessages(id: string, messages: LoomTranscriptMessage[]): Promise<void>;
	setSessionName(id: string, title: string): Promise<void>;
	resetSessionHandles(): void;
}

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
	private createAgent: LoomAgentFactory;
	private store: AgentSessionStore | undefined;
	/** One pi-backed conversation per AG-UI thread; clones share this map. */
	private sessions = new Map<string, LoomAgentInstance>();
	private titles = new Map<string, string>();

	constructor(
		options: LoomAgentOptions,
		createAgent: LoomAgentFactory = createLoomAgent,
		store?: AgentSessionStore,
	) {
		super({ agentId: "loom" });
		this.agentOptions = options;
		this.createAgent = createAgent;
		this.store = store;
	}

	// CopilotKit's runner clones the registered agent per run; the base clone()
	// only copies known base fields, so carry our own config across (mirrors
	// how HttpAgent.clone() preserves url/headers).
	override clone(): this {
		const cloned = super.clone() as this;
		cloned.agentOptions = this.agentOptions;
		cloned.createAgent = this.createAgent;
		cloned.store = this.store;
		cloned.sessions = this.sessions;
		cloned.titles = this.titles;
		return cloned;
	}

	resetSessions(): void {
		this.sessions.clear();
		this.titles.clear();
		this.store?.resetSessionHandles();
	}

	addTools(tools: LoomTool[]): void {
		if (!tools.length) return;
		const current = this.agentOptions.tools ?? [];
		if (!this.agentOptions.tools) this.agentOptions.tools = current;
		current.push(...tools);
		for (const session of this.sessions.values()) session.addTools(tools);
	}

	dropSession(id: string): void {
		this.sessions.delete(id);
		this.titles.delete(id);
	}

	run(input: RunAgentInput): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			const emit = (event: BaseEvent) => subscriber.next(event);
			let cancelled = false;

			// One assistant text message per run; open lazily on first text delta.
			const messageId = nextId("msg");
			let textOpen = false;
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

			let unsubscribe = (): void => undefined;

			void this.loadAgent(input.threadId).then(async (loom) => {
				if (cancelled) return;
				await this.ensureTitle(input.threadId, latestUserText(input));
				if (cancelled) return;
				const before = loom.getMessages().length;
				unsubscribe = loom.subscribe((event) => {
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
							emit({
								type: EventType.TOOL_CALL_START,
								toolCallId: event.toolCallId,
								toolCallName: event.name,
							} as BaseEvent);
							emit({
								type: EventType.TOOL_CALL_ARGS,
								toolCallId: event.toolCallId,
								delta: JSON.stringify(event.args ?? {}),
							} as BaseEvent);
							break;
						}

						case "tool_end": {
							emit({
								type: EventType.TOOL_CALL_END,
								toolCallId: event.toolCallId,
							} as BaseEvent);
							emit({
								type: EventType.TOOL_CALL_RESULT,
								messageId: nextId("tool-result"),
								toolCallId: event.toolCallId,
								content: event.result.content,
								role: "tool",
							} as BaseEvent);
							if (event.result.details !== undefined) {
								emit({
									type: EventType.CUSTOM,
									name: "loom.tool_result",
									value: {
										toolCallId: event.toolCallId,
										toolName: event.name,
										isError: event.isError,
										details: event.result.details,
									},
								} as BaseEvent);
							}
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
					.then(async () => {
						await this.persist(input.threadId, loom, before);
						if (!cancelled) subscriber.complete();
					})
					.catch((err) => {
						closeText();
						emit({
							type: EventType.RUN_ERROR,
							message: err instanceof Error ? err.message : String(err),
						} as BaseEvent);
						if (!cancelled) subscriber.error(err);
					});
			}).catch((err) => {
				if (!cancelled) subscriber.error(err);
			});

			return () => {
				cancelled = true;
				unsubscribe();
			};
		});
	}

	private async loadAgent(threadId: string): Promise<LoomAgentInstance> {
		const existing = this.sessions.get(threadId);
		if (existing) return existing;

		let initialMessages: LoomTranscriptMessage[] | undefined;
		if (this.store) {
			try {
				const record = await this.store.openSession(threadId);
				initialMessages = record.messages;
				this.titles.set(threadId, record.title);
			} catch {
				this.titles.set(threadId, DEFAULT_SESSION_TITLE);
			}
		}

		const loom = this.createAgent({ ...this.agentOptions, initialMessages });
		this.sessions.set(threadId, loom);
		return loom;
	}

	private async persist(threadId: string, loom: LoomAgentInstance, before: number): Promise<void> {
		if (!this.store) return;
		const messages = loom.getMessages();
		const added = messages.slice(before);
		try {
			await this.store.appendSessionMessages(threadId, added);
		} catch {
			// Persistence must not fail the chat run.
		}
	}

	private async ensureTitle(threadId: string, text: string): Promise<void> {
		if (!this.store || !text.trim()) return;
		if ((this.titles.get(threadId) ?? DEFAULT_SESSION_TITLE) !== DEFAULT_SESSION_TITLE) return;
		const next = titleFromUserText(text);
		try {
			await this.store.setSessionName(threadId, next);
			this.titles.set(threadId, next);
		} catch {
			// Title is best-effort and must not block the run.
		}
	}
}
