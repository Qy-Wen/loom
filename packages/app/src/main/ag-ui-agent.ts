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
	/** One pi-backed conversation per AG-UI thread; clones share this map. */
	private sessions = new Map<string, LoomAgentInstance>();
	private titles = new Map<string, string>();

	constructor(
		options: LoomAgentOptions,
		createAgent: LoomAgentFactory = createLoomAgent,
		store?: AgentSessionStore,
		getUiSelection?: () => UiSelectionFields | null,
	) {
		super({ agentId: "loom" });
		this.agentOptions = options;
		this.createAgent = createAgent;
		this.store = store;
		this.getUiSelection = getUiSelection;
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

	run(input: RunAgentInput): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			const emit = (event: BaseEvent) => subscriber.next(event);
			let cancelled = false;

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

			void this.loadAgent(input.threadId).then(async (loom) => {
				if (cancelled) return;
				await this.ensureTitle(input.threadId, latestUserText(input));
				if (cancelled) return;
				const before = loom.getMessages().length;
				unsubscribe = loom.subscribe((event) => {
					switch (event.type) {
						case "agent_start":
							startRun();
							break;
						case "error":
							fail(event.message);
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
							closeText();
							emit({
								type: EventType.RUN_FINISHED,
								threadId: input.threadId,
								runId: input.runId,
							} as BaseEvent);
							break;
					}
				});

				const attachment = uiSelectionToAttach(this.getUiSelection?.() ?? null, loom.getMessages());
				loom
					.prompt(latestUserText(input), attachment ? { attachments: [attachment] } : undefined)
					.then(async () => {
						if (!failed) await this.persist(input.threadId, loom, before);
						if (!cancelled) subscriber.complete();
					})
					.catch((err) => {
						fail(err);
						if (!cancelled) subscriber.complete();
					});
			}).catch((err) => {
				fail(err);
				if (!cancelled) subscriber.complete();
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
