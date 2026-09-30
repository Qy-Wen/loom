/**
 * AgUiAdapter — the single coupling point between Loom's agent and AG-UI.
 *
 * Wraps `@loom/agent` (LoomAgent) as an AG-UI `AbstractAgent`, so CopilotKit's
 * runtime can drive it. Translates `LoomAgentEvent` → AG-UI `BaseEvent`
 * (see AGENT.md §6.2). `LoomAgentEvent` never leaves this file.
 */
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { type BaseEvent, EventType } from "@ag-ui/core";
import {
	createLoomAgent,
	toolResultText,
	uiSelectionToAttach,
	type LoomAgent as LoomAgentInstance,
	type LoomAgentOptions,
	type LoomChatEndpoint,
	type LoomTool,
	type LoomTranscriptMessage,
	type UiSelectionFields,
} from "@loom/agent";
import { DEFAULT_SESSION_TITLE, titleFromUserText } from "@loom/core";
import { CHAT_ERROR_ID_PREFIX } from "../shared/chat-error.ts";
import { usageFromMessage } from "../shared/agent-stats.ts";
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

export function formatChatError(cause: unknown): string {
	const raw = cause instanceof Error ? cause.message : String(cause);
	if (/Chat is not configured/i.test(raw)) {
		return "Set a base URL and model in Settings.";
	}
	if (/401|unauthorized|invalid api key|incorrect api key|authentication/i.test(raw)) {
		return `API key was rejected. Check the Chat key in Settings.\n${raw}`;
	}
	return raw.trim() || "The Chat endpoint did not return a reply.";
}

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
	private getUiSelection: (() => UiSelectionFields | null) | undefined;
	private onUsage: ((usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void) | undefined;
	/** One pi-backed conversation per AG-UI thread; clones share this map. */
	private sessions = new Map<string, LoomAgentInstance>();
	private titles = new Map<string, string>();
	/** In-flight prompt per thread, so Stop and the next run can abort it. */
	private inflight = new Map<string, { abort: (reason?: "user") => void; done: Promise<void> }>();

	constructor(
		options: LoomAgentOptions,
		createAgent: LoomAgentFactory = createLoomAgent,
		store?: AgentSessionStore,
		getUiSelection?: () => UiSelectionFields | null,
		onUsage?: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void,
	) {
		super({ agentId: "loom" });
		this.agentOptions = options;
		this.createAgent = createAgent;
		this.store = store;
		this.getUiSelection = getUiSelection;
		this.onUsage = onUsage;
	}

	// CopilotKit's runner clones the registered agent per run; the base clone()
	// only copies known base fields, so carry our own config across (mirrors
	// how HttpAgent.clone() preserves url/headers).
	override clone(): this {
		const cloned = super.clone() as this;
		cloned.agentOptions = this.agentOptions;
		cloned.createAgent = this.createAgent;
		cloned.store = this.store;
		cloned.getUiSelection = this.getUiSelection;
		cloned.onUsage = this.onUsage;
		cloned.sessions = this.sessions;
		cloned.titles = this.titles;
		cloned.inflight = this.inflight;
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

	setTools(tools: LoomTool[]): void {
		this.agentOptions.tools = [...tools];
		this.resetSessions();
	}

	setSystemPrompt(systemPrompt: string): void {
		this.agentOptions.systemPrompt = systemPrompt;
		for (const session of this.sessions.values()) session.setSystemPrompt(systemPrompt);
	}

	setChat(chat: LoomChatEndpoint | undefined): void {
		this.agentOptions.chat = chat;
		this.resetSessions();
	}

	dropSession(id: string): void {
		this.sessions.delete(id);
		this.titles.delete(id);
	}

	/**
	 * CopilotKit Stop calls this. The base implementation does nothing, so the
	 * run Observable stays subscribed and tools keep running. Detach unsubscribes
	 * `run()`, which aborts the in-flight Loom agent.
	 */
	override abortRun(): void {
		if (this.threadId) this.inflight.get(this.threadId)?.abort("user");
		void this.detachActiveRun();
	}

	run(input: RunAgentInput): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			const emit = (event: BaseEvent) => subscriber.next(event);
			let cancelled = false;
			let loom: LoomAgentInstance | undefined;
			let resolveInflight = (): void => undefined;
			const inflightDone = new Promise<void>((resolve) => {
				resolveInflight = resolve;
			});
			const handle = {
				abort: (reason?: "user") => loom?.abort(reason),
				done: inflightDone,
			};
			const previous = this.inflight.get(input.threadId);
			this.inflight.set(input.threadId, handle);
			const releaseInflight = () => {
				resolveInflight();
				if (this.inflight.get(input.threadId) === handle) this.inflight.delete(input.threadId);
			};

			// One assistant text message per text segment. Reusing a single id for
			// the whole run makes CopilotChat paint all text, then dump every tool.
			let messageId = "";
			let textOpen = false;
			const openText = (id = nextId("msg")) => {
				if (textOpen) return;
				messageId = id;
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
			const parentForTool = (): string => {
				if (!messageId) {
					openText();
					closeText();
				} else if (textOpen) {
					closeText();
				}
				return messageId;
			};

			let thinkingId = "";
			let thinkingOpen = false;
			const openThinking = () => {
				if (thinkingOpen) return;
				closeText();
				thinkingId = nextId("think");
				thinkingOpen = true;
				emit({ type: EventType.REASONING_START, messageId: thinkingId } as BaseEvent);
				emit({
					type: EventType.REASONING_MESSAGE_START,
					messageId: thinkingId,
					role: "reasoning",
				} as BaseEvent);
			};
			const closeThinking = () => {
				if (!thinkingOpen) return;
				thinkingOpen = false;
				emit({ type: EventType.REASONING_MESSAGE_END, messageId: thinkingId } as BaseEvent);
				emit({ type: EventType.REASONING_END, messageId: thinkingId } as BaseEvent);
			};

			let unsubscribe = (): void => undefined;
			let started = false;
			let failed = false;
			const startRun = () => {
				if (started) return;
				started = true;
				emit({
					type: EventType.RUN_STARTED,
					threadId: input.threadId,
					runId: input.runId,
				} as BaseEvent);
			};
			const fail = (cause: unknown) => {
				const message = formatChatError(cause);
				if (failed) return message;
				failed = true;
				startRun();
				closeThinking();
				closeText();
				openText(nextId(CHAT_ERROR_ID_PREFIX.slice(0, -1)));
				emit({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId,
					delta: message,
				} as BaseEvent);
				closeText();
				emit({ type: EventType.RUN_ERROR, message } as BaseEvent);
				return message;
			};

			void (async () => {
				try {
					if (previous) {
						previous.abort();
						await previous.done;
					}
					if (cancelled) return;
					loom = await this.loadAgent(input.threadId);
					if (cancelled) {
						loom.abort();
						return;
					}
					await this.ensureTitle(input.threadId, latestUserText(input));
					if (cancelled) {
						loom.abort();
						return;
					}
				const agent = loom;
				const before = agent.getMessages().length;
				unsubscribe = agent.subscribe((event) => {
					switch (event.type) {
						case "agent_start":
							startRun();
							break;
						case "error":
							fail(event.message);
							break;

						case "thinking_start":
							openThinking();
							break;
						case "thinking_delta":
							openThinking();
							emit({
								type: EventType.REASONING_MESSAGE_CONTENT,
								messageId: thinkingId,
								delta: event.delta,
							} as BaseEvent);
							break;
						case "thinking_end":
							closeThinking();
							break;

						case "text":
							closeThinking();
							openText();
							emit({
								type: EventType.TEXT_MESSAGE_CONTENT,
								messageId,
								delta: event.delta,
							} as BaseEvent);
							break;

						case "tool_start": {
							closeThinking();
							emit({
								type: EventType.TOOL_CALL_START,
								toolCallId: event.toolCallId,
								toolCallName: event.name,
								parentMessageId: parentForTool(),
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
								content: toolResultText(event.result.content),
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
							if (failed) break;
							closeThinking();
							closeText();
							emit({
								type: EventType.RUN_FINISHED,
								threadId: input.threadId,
								runId: input.runId,
							} as BaseEvent);
							break;
					}
				});

				const attachment = uiSelectionToAttach(this.getUiSelection?.() ?? null, agent.getMessages());
				await agent
					.prompt(latestUserText(input), attachment ? { attachments: [attachment] } : undefined)
					.then(async () => {
						if (!failed) {
							this.recordUsage(agent.getMessages().slice(before));
							await this.persist(input.threadId, agent, before);
						}
						if (!cancelled) subscriber.complete();
					})
					.catch((err) => {
						fail(err);
						if (!cancelled) subscriber.complete();
					});
				} catch (err) {
					fail(err);
					if (!cancelled) subscriber.complete();
				} finally {
					releaseInflight();
				}
			})();

			return () => {
				cancelled = true;
				unsubscribe();
				loom?.abort();
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

	private recordUsage(messages: LoomTranscriptMessage[]): void {
		if (!this.onUsage) return;
		for (const message of messages) {
			const usage = usageFromMessage(message);
			if (usage) this.onUsage(usage);
		}
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
