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
	DEFAULT_SESSION_TITLE,
	titleFromUserText,
	promptAttachments,
	type ComposerImageInput,
	type HarnessSessionManager,
	type LoomAgentEvent,
	type AssetRefAttachment,
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

function composerUserText(raw: string): string {
	const stripped = raw.replaceAll("\u200b", "");
	return stripped.trim() ? stripped : "";
}

export class LoomAgUiAgent extends AbstractAgent {
	private manager: HarnessSessionManager;
	private getUiSelection: (() => UiSelectionFields | null) | undefined;
	private takeComposerImages: ((sessionId: string) => Promise<ComposerImageInput[]>) | undefined;
	private takeComposerAssets: ((sessionId: string) => Promise<AssetRefAttachment[]>) | undefined;
	/** In-flight prompt per thread, so Stop and the next run can abort it. */
	private inflight = new Map<string, { abort: (reason?: "user") => Promise<void>; done: Promise<void> }>();

	constructor(
		manager: HarnessSessionManager,
		getUiSelection?: () => UiSelectionFields | null,
		takeComposerImages?: (sessionId: string) => Promise<ComposerImageInput[]>,
		takeComposerAssets?: (sessionId: string) => Promise<AssetRefAttachment[]>,
	) {
		super({ agentId: "loom" });
		this.manager = manager;
		this.getUiSelection = getUiSelection;
		this.takeComposerImages = takeComposerImages;
		this.takeComposerAssets = takeComposerAssets;
	}

	// CopilotKit clones the registered agent per run; keep the shared manager
	// and in-flight map across clones so Stop can reach the active run.
	override clone(): this {
		const cloned = super.clone() as this;
		cloned.manager = this.manager;
		cloned.getUiSelection = this.getUiSelection;
		cloned.takeComposerImages = this.takeComposerImages;
		cloned.takeComposerAssets = this.takeComposerAssets;
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
					const text = composerUserText(latestUserText(input));
					const images = await this.takeComposerImages?.(input.threadId) ?? [];
					const chips = await this.takeComposerAssets?.(input.threadId) ?? [];
					if (cancelled) return;
					await this.ensureTitle(input.threadId, session.title, text);
					if (cancelled) return;
					const attachments = promptAttachments(chips, this.getUiSelection?.() ?? null, session.messages);
					prompting = true;
					let retryVisible = false;
					let retryMaxAttempts = 0;
					let retryError: string | undefined;
					const toolProgress = new Set<string>();
					const startedTools = new Set<string>();
					const startToolCall = (toolCallId: string, name: string, args: unknown) => {
						if (startedTools.has(toolCallId)) return;
						startedTools.add(toolCallId);
						closeThinking();
						emit({
							type: EventType.TOOL_CALL_START,
							toolCallId,
							toolCallName: name,
							parentMessageId: parentForTool(),
						} as BaseEvent);
						emit({
							type: EventType.TOOL_CALL_ARGS,
							toolCallId,
							delta: JSON.stringify(args ?? {}),
						} as BaseEvent);
					};
					const retryActivity = (content: { phase: "wait" | "running" | "done"; attempt: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }) => {
						retryVisible = content.phase !== "done";
						emit({
							type: EventType.ACTIVITY_SNAPSHOT,
							messageId: "loom-retry",
							activityType: "loom.retry",
							content,
						} as BaseEvent);
					};
					const toolActivity = (toolCallId: string, content: { name: string; text: string; hidden: boolean }) => {
						emit({
							type: EventType.ACTIVITY_SNAPSHOT,
							messageId: `loom-tool-${toolCallId}`,
							activityType: "loom.tool_progress",
							content,
						} as BaseEvent);
					};
					await this.manager.prompt(input.threadId, text, {
						...(attachments.length > 0 ? { attachments } : {}),
						...(images.length > 0 ? { images } : {}),
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

								case "retry_scheduled":
									retryMaxAttempts = event.maxAttempts;
									retryError = event.errorMessage;
									retryActivity({
										phase: "wait",
										attempt: event.attempt,
										maxAttempts: event.maxAttempts,
										delayMs: event.delayMs,
										errorMessage: event.errorMessage,
									});
									break;
								case "retry_start":
									retryActivity({
										phase: "running",
										attempt: event.attempt,
										maxAttempts: retryMaxAttempts || undefined,
										errorMessage: retryError,
									});
									break;
								case "retry_end":
									if (retryVisible) retryActivity({ phase: "done", attempt: 0 });
									break;

								case "tool_pending":
									startToolCall(event.toolCallId, event.name, event.args);
									break;

								case "tool_start":
									startToolCall(event.toolCallId, event.name, event.args);
									break;

								case "tool_progress":
									toolProgress.add(event.toolCallId);
									toolActivity(event.toolCallId, { name: event.name, text: event.text, hidden: false });
									break;

								case "tool_end": {
									if (toolProgress.delete(event.toolCallId)) {
										toolActivity(event.toolCallId, { name: event.name, text: "", hidden: true });
									}
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

								case "follow_up_sent": {
									closeThinking();
									closeText();
									const userId = nextId("user");
									emit({
										type: EventType.TEXT_MESSAGE_START,
										messageId: userId,
										role: "user",
									} as BaseEvent);
									emit({
										type: EventType.TEXT_MESSAGE_CONTENT,
										messageId: userId,
										delta: event.text,
									} as BaseEvent);
									emit({
										type: EventType.TEXT_MESSAGE_END,
										messageId: userId,
									} as BaseEvent);
									break;
								}

								case "agent_end":
									if (retryVisible) retryActivity({ phase: "done", attempt: 0 });
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
