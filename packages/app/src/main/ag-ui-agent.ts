/**
 * AgUiAdapter — the single coupling point between Loom's agent and AG-UI.
 *
 * Wraps the shared HarnessSessionManager as an AG-UI `AbstractAgent`, so
 * CopilotKit's runtime can drive it. Translates `LoomAgentEvent` → AG-UI `BaseEvent`
 * (see AGENT.md §6.2). `LoomAgentEvent` never leaves this file.
 */
import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { type BaseEvent, EventType } from "@ag-ui/core";
import {
	toolResultText,
	uiSelectionToAttach,
	DEFAULT_SESSION_TITLE,
	titleFromUserText,
	type HarnessSessionManager,
	type LoomAgentEvent,
	type UiSelectionFields,
} from "@loom/agent";
import { CHAT_ERROR_ID_PREFIX } from "../shared/chat-error.ts";
import { Observable } from "rxjs";

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
	private manager: HarnessSessionManager;
	private getUiSelection: (() => UiSelectionFields | null) | undefined;
	/** In-flight prompt per thread, so Stop and the next run can abort it. */
	private inflight = new Map<string, { abort: (reason?: "user") => Promise<void>; done: Promise<void> }>();

	constructor(manager: HarnessSessionManager, getUiSelection?: () => UiSelectionFields | null) {
		super({ agentId: "loom" });
		this.manager = manager;
		this.getUiSelection = getUiSelection;
	}

	// CopilotKit clones the registered agent per run; keep the shared manager
	// and in-flight map across clones so Stop can reach the active run.
	override clone(): this {
		const cloned = super.clone() as this;
		cloned.manager = this.manager;
		cloned.getUiSelection = this.getUiSelection;
		cloned.inflight = this.inflight;
		return cloned;
	}

	/**
	 * CopilotKit Stop calls this. The base implementation does nothing, so the
	 * run Observable stays subscribed and tools keep running. Detach unsubscribes
	 * `run()`, which aborts the in-flight Harness run.
	 */
	override abortRun(): void {
		if (this.threadId) void this.inflight.get(this.threadId)?.abort("user");
		void this.detachActiveRun();
	}

	run(input: RunAgentInput): Observable<BaseEvent> {
		return new Observable<BaseEvent>((subscriber) => {
			const emit = (event: BaseEvent) => subscriber.next(event);
			let cancelled = false;
			let prompting = false;
			let resolveInflight = (): void => undefined;
			const inflightDone = new Promise<void>((resolve) => {
				resolveInflight = resolve;
			});
			const handle = {
				abort: async (reason?: "user") => {
					if (prompting) await this.manager.abort(input.threadId, reason);
				},
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
						await previous.abort();
						await previous.done;
					}
					if (cancelled) return;
					const session = await this.manager.openSession(input.threadId);
					if (cancelled) return;
					await this.ensureTitle(input.threadId, session.title, latestUserText(input));
					if (cancelled) return;
					const attachment = uiSelectionToAttach(this.getUiSelection?.() ?? null, session.messages);
					prompting = true;
					await this.manager.prompt(input.threadId, latestUserText(input), {
						...(attachment ? { attachments: [attachment] } : {}),
						onEvent: (event: LoomAgentEvent) => {
							if (cancelled) {
								if (event.type === "agent_start") void handle.abort();
								return;
							}
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

								case "compaction_start":
								emit({
									type: EventType.CUSTOM,
									name: "loom.compaction",
									value: { phase: "start", reason: event.reason },
								} as BaseEvent);
								break;
							case "compaction_end":
								emit({
									type: EventType.CUSTOM,
									name: "loom.compaction",
									value: { phase: "end", reason: event.reason, status: event.status },
								} as BaseEvent);
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
						},
					});
					prompting = false;
					if (!cancelled) subscriber.complete();
				} catch (err) {
					prompting = false;
					if (!cancelled) {
						fail(err);
						subscriber.complete();
					}
				} finally {
					releaseInflight();
				}
			})();

			return () => {
				cancelled = true;
				void handle.abort();
			};
		});
	}

	private async ensureTitle(threadId: string, title: string, text: string): Promise<void> {
		if (!text.trim() || title !== DEFAULT_SESSION_TITLE) return;
		try {
			await this.manager.setSessionName(threadId, titleFromUserText(text));
		} catch {
			// Title is best-effort and must not block the run.
		}
	}
}
