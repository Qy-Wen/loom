import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import {
	BACKGROUND_CONTEXT as context, watchEvents, LoomApprovalsDoc, toolEventId,
	contentWithPlacedAssets, implicitSelectionAttachments, foldUserText, titleFromUserText,
	DEFAULT_SESSION_TITLE, type AgentEvent, type ComposerImageInput, type AssetRefAttachment, type UiSelectionFields, type DocumentWatch, type PendingToolApproval, type ConversationId,
} from "@loom/agent";
import type { LibraryAgentHost } from "./library-agent-host.ts";
import { toAgUiMessages, transcriptText } from "../shared/ag-ui-messages.ts";
import { formatChatError } from "../shared/chat-error.ts";
import { Observable } from "rxjs";

let next = 0;
const temporaryId = () => `loom-live-${Date.now()}-${next++}`;
const latestUserText = (input: RunAgentInput) => {
	const message = input.messages.findLast((message) => message.role === "user");
	return transcriptText(message?.content).replaceAll("\u200b", "");
};

/** Protocol boundary: durable commit events + Loom approval document -> AG-UI increments. */
export class LoomAgUiAgent extends AbstractAgent {
	active = new Map<string, { abort: () => Promise<void>; done: Promise<void> }>();
	private host: LibraryAgentHost;
	private getUiSelection?: () => UiSelectionFields | null;
	private takeComposerImages?: (id: string) => Promise<ComposerImageInput[]>;
	private takeComposerAssets?: (id: string) => Promise<AssetRefAttachment[]>;
	constructor(
		host: LibraryAgentHost,
		getUiSelection?: () => UiSelectionFields | null,
		takeComposerImages?: (id: string) => Promise<ComposerImageInput[]>,
		takeComposerAssets?: (id: string) => Promise<AssetRefAttachment[]>,
	) {
		super({ agentId: "loom" }); this.host = host; this.getUiSelection = getUiSelection;
		this.takeComposerImages = takeComposerImages; this.takeComposerAssets = takeComposerAssets;
	}
	override clone(): this { const clone = super.clone() as this; clone.active = this.active; clone.host = this.host; clone.getUiSelection = this.getUiSelection; clone.takeComposerImages = this.takeComposerImages; clone.takeComposerAssets = this.takeComposerAssets; return clone; }
	override abortRun(): void { if (this.threadId) void this.active.get(this.threadId)?.abort().catch(() => {}); void this.detachActiveRun(); }

	run(input: RunAgentInput): Observable<BaseEvent> { return this.observe(input, true); }

	/** Attach to persisted work without submitting, consuming composer inputs, or aborting on detach. */
	connectThread(threadId: string): Observable<BaseEvent> {
		return this.observe({ threadId, runId: `loom-connect-${temporaryId()}`, messages: [], state: {}, tools: [], context: [], forwardedProps: {} }, false);
	}

	private observe(input: RunAgentInput, submit: boolean): Observable<BaseEvent> {
		return new Observable((subscriber) => {
			const emit = (event: object) => subscriber.next(event as BaseEvent);
			let cancelled = false;
			let finished = false;
			let abort = async () => {};
			const complete = Promise.withResolvers<void>();
			const detached = Promise.withResolvers<void>();
			const handle = { abort: () => abort(), done: complete.promise };
			const previous = submit ? this.active.get(input.threadId) : undefined;
			if (submit) this.active.set(input.threadId, handle);
			void (async () => {
				const childWatches: Array<{ stop: () => Promise<unknown> }> = [];
				const watchedChildren = new Set<number>();
				let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
				let approvals: DocumentWatch<{ pending: PendingToolApproval[] }> | undefined;
				try {
					if (previous) { await previous.abort(); await previous.done; }
					if (cancelled) return;
					const owner = this.host.requireOwner();
					const conversation = await this.host.conversation(input.threadId);
					abort = () => conversation.abort(context);
					const record = await this.host.getSession(input.threadId);
					const raw = latestUserText(input);
					const images = submit ? await this.takeComposerImages?.(input.threadId) ?? [] : [];
					const chips = submit ? await this.takeComposerAssets?.(input.threadId) ?? [] : [];
					if (cancelled) return;
					if (submit && record.title === DEFAULT_SESSION_TITLE && raw.trim()) await this.host.setSessionName(input.threadId, titleFromUserText(raw));
					const body = contentWithPlacedAssets(raw, chips);
					const attachments = submit ? implicitSelectionAttachments(chips, this.getUiSelection?.(), record.messages) : [];
					const folded = foldUserText(body, attachments);
					if (submit && !folded.trim() && !images.length) throw new Error("Enter a message first.");
					stream = await watchEvents(owner.harness, conversation.id, context);
					if (!submit) {
						const id = stream.snapshot.run?.inputs[0];
						const record = id === undefined ? undefined : await owner.harness.submission(id, context);
						const state = await record?.status(context);
						input = { ...input, runId: state?.requestId ?? input.runId };
					}
					emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
					let messageId = temporaryId();
					let textOpen = false;
					let reasoningOpen = false;
					let sentText = "";
					let sentThinking = "";
					const partialBlocks = new Map<number, { type: string; text?: string; thinking?: string; redacted?: boolean }>();
					const close = () => {
						if (reasoningOpen) { emit({ type: EventType.REASONING_MESSAGE_END, messageId: `${messageId}-thinking` }); emit({ type: EventType.REASONING_END, messageId: `${messageId}-thinking` }); reasoningOpen = false; }
						if (textOpen) { emit({ type: EventType.TEXT_MESSAGE_END, messageId }); textOpen = false; }
					};
					const textDelta = (delta: string) => {
						if (!delta) return;
						if (!textOpen) { textOpen = true; emit({ type: EventType.TEXT_MESSAGE_START, role: "assistant", messageId }); }
						emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta }); sentText += delta;
					};
					const thinkingDelta = (delta: string) => {
						if (!delta) return;
						if (!reasoningOpen) { reasoningOpen = true; emit({ type: EventType.REASONING_START, messageId: `${messageId}-thinking` }); emit({ type: EventType.REASONING_MESSAGE_START, role: "reasoning", messageId: `${messageId}-thinking` }); }
						emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: `${messageId}-thinking`, delta }); sentThinking += delta;
					};
					const renderPartial = () => {
						const blocks = [...partialBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
						const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
						const thinking = blocks.filter((block) => block.type === "thinking" && !block.redacted).map((block) => block.thinking ?? "").join("");
						if (thinking.startsWith(sentThinking)) thinkingDelta(thinking.slice(sentThinking.length));
						if (text.startsWith(sentText)) textDelta(text.slice(sentText.length));
					};
					const watchChild = async (id: number) => {
						if (watchedChildren.has(id)) return;
						watchedChildren.add(id);
						const child = await watchEvents(owner.harness, id as ConversationId, context);
						childWatches.push(child);
						const restoreChild = async (snapshot: typeof child.snapshot) => {
							for (const slot of snapshot.tools) {
								const args = snapshot.entries.flatMap((entry) => entry.model ?? []).flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === slot.callId);
								startTool(toolEventId(id as ConversationId, slot.callId), slot.name, args?.type === "toolCall" ? args.arguments : {});
							}
						};
						await restoreChild(child.snapshot);
						child.start(async (events) => {
							for (const event of events) {
								if (event.type === "snapshot") await restoreChild(event);
								if (event.type === "tool_execution_start") startTool(toolEventId(id as ConversationId, event.toolCallId), event.toolName, event.args);
								if (event.type === "tool_execution_end") {
									const toolId = toolEventId(id as ConversationId, event.toolCallId); const result = event.entry?.model?.[0];
									emit({ type: EventType.TOOL_CALL_END, toolCallId: toolId });
									emit({ type: EventType.TOOL_CALL_RESULT, messageId: String(event.entry?.id ?? toolId), toolCallId: toolId, role: "tool", content: result && "content" in result ? transcriptText(result.content) : "" });
									if (result?.role === "toolResult" && result.details !== undefined) emit({ type: EventType.CUSTOM, name: "loom.tool_result", value: { toolCallId: toolId, toolName: event.toolName, isError: result.isError, details: result.details } });
								}
							}
						});
						const approval = await owner.harness.watchDoc(LoomApprovalsDoc, id as ConversationId, context);
						if (approval) {
							childWatches.push(approval);
							const show = approvalPresenter();
							show(approval.value);
							approval.start(async (value) => { show(value); });
						}
					};
					const knownTools = new Set<string>();
					const snapshottedTools = new Set<string>();
					const progress = new Map<string, string>();
					let submittedEntry: string | undefined;
					const done = Promise.withResolvers<void>();
					const startTool = (id: string, name: string, args: unknown) => {
						if (knownTools.has(id)) return;
						close(); knownTools.add(id);
						emit({ type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId: messageId });
						if (!snapshottedTools.has(id)) emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: JSON.stringify(args) });
					};
					const existingRequest = submit ? await owner.harness.commit((tx) => tx.submissionByRequest(conversation.id, input.runId), context) : undefined;
					const snapshotMessages = async () => {
						const messages = toAgUiMessages((await this.host.getSession(input.threadId)).messages);
						const optimisticUser = input.messages.findLast((message) => message.role === "user");
						// Before admission, keep the current user row. Removing it makes the renderer
						// mistake the live assistant/tool messages for another thread's continuation.
						if (submit && !existingRequest && !submittedEntry && optimisticUser) messages.push(optimisticUser);
						return messages;
					};
					const onEvent = async (event: AgentEvent) => {
						if (cancelled) return;
						switch (event.type) {
							case "snapshot": {
								const messages = await snapshotMessages();
								for (const message of messages) if (message.role === "assistant") for (const call of message.toolCalls ?? []) snapshottedTools.add(call.id);
								emit({ type: EventType.MESSAGES_SNAPSHOT, messages });
								if (!submit && event.generation?.message) {
									partialBlocks.clear();
									event.generation.message.content.forEach((block, index) => partialBlocks.set(index, { ...block }));
									renderPartial();
								}
								for (const slot of event.tools) {
									const args = event.entries.flatMap((entry) => entry.model ?? []).flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.type === "toolCall" && part.id === slot.callId);
									if (slot.status !== "done") startTool(toolEventId(conversation.id, slot.callId), slot.name, args?.type === "toolCall" ? args.arguments : {});
									const childId = (slot.details as { conversationId?: number } | undefined)?.conversationId;
									if (childId) await watchChild(childId);
								}
								break;
							}
							case "turn_start": close(); messageId = temporaryId(); sentText = ""; sentThinking = ""; partialBlocks.clear(); break;
							case "message_start":
								if (event.message.role === "assistant") {
									partialBlocks.clear();
									event.message.content.forEach((block, index) => partialBlocks.set(index, { ...block }));
									renderPartial();
								}
								break;
							case "message_update":
								for (const change of event.changes) {
									if (change.type === "message") {
										partialBlocks.clear();
										change.message.content.forEach((block, index) => partialBlocks.set(index, { ...block }));
									} else if ("block" in change) partialBlocks.set(change.contentIndex, { ...change.block });
									else if (change.type === "text_delta" || change.type === "thinking_delta") {
										const field = change.type === "text_delta" ? "text" : "thinking";
										const block = partialBlocks.get(change.contentIndex) ?? { type: field };
										block[field] = (block[field] ?? "") + change.delta;
										partialBlocks.set(change.contentIndex, block);
									}
								}
								renderPartial(); break;
							case "message_end": {
								const message = event.entry.model?.[0];
								if (message?.role === "user") {
									const id = String(event.entry.id);
									if (!submittedEntry) { submittedEntry = id; emit({ type: EventType.CUSTOM, name: "loom.user_entry", value: { entryId: id } }); }
									else { emit({ type: EventType.TEXT_MESSAGE_START, role: "user", messageId: id }); emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: (event.entry.data as { text?: string })?.text ?? transcriptText(message.content) }); emit({ type: EventType.TEXT_MESSAGE_END, messageId: id }); }
									break;
								}
								if (message?.role !== "assistant") break;
								const text = transcriptText(message.content);
								const thinking = message.content.filter((part) => part.type === "thinking" && !part.redacted).map((part) => part.type === "thinking" ? part.thinking : "").join("");
								if (thinking.startsWith(sentThinking)) thinkingDelta(thinking.slice(sentThinking.length));
								if (text.startsWith(sentText)) textDelta(text.slice(sentText.length));
								close();
								emit({ type: EventType.CUSTOM, name: "loom.adopt_entry", value: { fromId: messageId, entryId: String(event.entry.id) } });
								messageId = String(event.entry.id);
								break;
							}
							case "tool_execution_start": startTool(toolEventId(conversation.id, event.toolCallId), event.toolName, event.args); break;
							case "tool_execution_update": {
								const childId = (event.details as { conversationId?: number } | undefined)?.conversationId;
								if (childId) await watchChild(childId);
								const id = toolEventId(conversation.id, event.toolCallId);
								const prior = progress.get(id) ?? "";
								const value = event.output && "set" in event.output ? event.output.set : prior.slice(event.output?.trimStart ?? 0) + (event.output?.append ?? "");
								progress.set(id, value);
								emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-tool-${id}`, activityType: "loom.tool_progress", content: { name: event.toolName, text: value, hidden: false } }); break;
							}
							case "tool_execution_end": {
								const id = toolEventId(conversation.id, event.toolCallId); const result = event.entry?.model?.[0];
								emit({ type: EventType.TOOL_CALL_END, toolCallId: id });
								emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-tool-${id}`, activityType: "loom.tool_progress", content: { name: event.toolName, text: "", hidden: true } });
								emit({ type: EventType.TOOL_CALL_RESULT, messageId: String(event.entry?.id ?? id), toolCallId: id, role: "tool", content: result && "content" in result ? transcriptText(result.content) : JSON.stringify(event.result?.structuredOutput ?? "") });
								if (result?.role === "toolResult" && result.details !== undefined) emit({ type: EventType.CUSTOM, name: "loom.tool_result", value: { toolCallId: id, toolName: event.toolName, isError: result.isError, details: result.details } });
								break;
							}
							case "auto_retry_start": emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: "loom-retry", activityType: "loom.retry", content: { phase: "wait", attempt: event.attempt, delayMs: Math.max(0, event.at - Date.now()), errorMessage: event.errorMessage } }); break;
							case "auto_retry_end": emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: "loom-retry", activityType: "loom.retry", content: { phase: "done", attempt: event.attempt } }); break;
							case "compaction_start": case "compaction_end": emit({ type: EventType.CUSTOM, name: "loom.compaction", value: { phase: event.type === "compaction_start" ? "start" : "end", reason: event.reason, ...(event.type === "compaction_end" ? { status: event.error ? "failed" : "completed" } : {}) } }); break;
							case "run_end": done.resolve(); break;
						}
					};
					const approvalPresenter = () => {
						let pending = new Set<string>();
						return (value: { pending: PendingToolApproval[] } | null) => {
							const current = new Set(value?.pending.map((row) => row.toolCallId));
							for (const row of value?.pending ?? []) { startTool(row.toolCallId, row.toolName, row.args); emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-gate-${row.toolCallId}`, activityType: "loom.tool_gate", content: { toolCallId: row.toolCallId, pending: true } }); }
							for (const id of pending) if (!current.has(id)) emit({ type: EventType.ACTIVITY_SNAPSHOT, messageId: `loom-gate-${id}`, activityType: "loom.tool_gate", content: { toolCallId: id, pending: false } });
							pending = current;
						};
					};
					await onEvent(stream.snapshot);
					stream.start(async (events) => { for (const event of events) await onEvent(event); });
					approvals = await owner.harness.watchDoc(LoomApprovalsDoc, conversation.id, context);
					if (approvals) { const show = approvalPresenter(); show(approvals.value); approvals.start(async (value) => { show(value); }); }
					const content = images.length ? [{ type: "text" as const, text: folded }, ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))] : folded;
					if (submit) {
						const submission = await conversation.submit({ type: "input", content, whenBusy: "reject", requestId: input.runId, entry: { kind: "loom.user", data: { text: body } } }, context);
						const settled = await submission.wait(context);
						if (settled.status === "done" && settled.type === "input" && !stream.snapshot.entries.some((entry) => entry.id === settled.answer)) await Promise.race([done.promise, stream.closed]);
						if (settled.status === "unanswered" && settled.reason !== "aborted") throw new Error(typeof settled.detail === "string" ? settled.detail : settled.reason);
					} else if (stream.snapshot.run) await Promise.race([done.promise, stream.closed, detached.promise]);
					close();
					if (!cancelled) { emit({ type: EventType.MESSAGES_SNAPSHOT, messages: toAgUiMessages((await this.host.getSession(input.threadId)).messages) }); emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId }); }
				} catch (error) {
					if (!cancelled) emit({ type: EventType.RUN_ERROR, message: formatChatError(error) });
				} finally {
					await approvals?.stop(); await stream?.stop();
					for (const child of childWatches) await child.stop();
					finished = true;
					complete.resolve(); if (this.active.get(input.threadId) === handle) this.active.delete(input.threadId);
					if (!cancelled) subscriber.complete();
				}
			})();
			return () => { cancelled = true; detached.resolve(); if (submit && !finished) void abort().catch(() => {}); };
		});
	}
}
