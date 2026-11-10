import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { BACKGROUND_CONTEXT as context, ConversationTranscript, type ConversationView, type ConversationWatch, type DocumentWatch, type EntryId, type LiveState, type PendingToolApproval, type TranscriptView } from "@loom/agent";
import type { ChatService } from "./chat-service.ts";
import { createAgUiEvents, temporaryMessageId } from "./ag-ui-events.ts";
import { createConversationActivity } from "./conversation-activity.ts";
import { transcriptText } from "../../shared/ag-ui-messages.ts";
import { formatChatError } from "../../shared/chat-error.ts";
import { Observable } from "rxjs";

/** Protocol boundary: native conversation state and Loom approvals become AG-UI increments. */
export class AgUiAdapter extends AbstractAgent {
	active = new Map<string, { abort: () => Promise<void>; done: Promise<void> }>();
	private service: ChatService;
	constructor(service: ChatService) { super({ agentId: "loom" }); this.service = service; }
	override clone(): this { const clone = super.clone() as this; clone.active = this.active; clone.service = this.service; return clone; }
	override abortRun(): void { if (this.threadId) void this.active.get(this.threadId)?.abort().catch(() => {}); void this.detachActiveRun(); }

	run(input: RunAgentInput): Observable<BaseEvent> { return this.observe(input, true); }

	/** Attach to persisted work without submitting, consuming composer inputs, or aborting on detach. */
	connectThread(threadId: string): Observable<BaseEvent> {
		return this.observe({ threadId, runId: `loom-connect-${temporaryMessageId()}`, messages: [], state: {}, tools: [], context: [], forwardedProps: {} }, false);
	}

	private observe(input: RunAgentInput, submit: boolean): Observable<BaseEvent> {
		return new Observable((subscriber) => {
			let cancelled = false;
			const emit = (event: object) => { if (!cancelled) subscriber.next(event as BaseEvent); };
			let finished = false;
			let abort = async () => {};
			const complete = Promise.withResolvers<void>();
			const detached = Promise.withResolvers<void>();
			const failure = Promise.withResolvers<never>();
			// A child watcher may fail before the main watcher reaches its completion race.
			void failure.promise.catch(() => {});
			const handle = { abort: () => abort(), done: complete.promise };
			const previous = submit ? this.active.get(input.threadId) : undefined;
			if (submit) this.active.set(input.threadId, handle);
			void (async () => {
				const childWatches: Array<{ stop: () => Promise<unknown> }> = [];
				const watchedChildren = new Set<number>();
				let stream: ConversationWatch | undefined;
				let approvals: DocumentWatch<{ pending: PendingToolApproval[] }> | undefined;
				const checkEnd = (watch: { closed: Promise<import("@loom/agent").WatchEnd> }) => {
					void watch.closed.then((end) => { if ("error" in end) failure.reject(end.error); });
				};
				try {
					if (previous) { await previous.abort(); await previous.done; }
					if (cancelled) return;
					const connection = await this.service.connect(input.threadId);
					abort = connection.abort;
					const optimisticUser = input.messages.findLast((message) => message.role === "user");
					const turn = submit ? await connection.prepareTurn(transcriptText(optimisticUser?.content), { requestId: input.runId, clientMessageId: optimisticUser?.id }) : undefined;
					if (cancelled) return;
					const attached = await connection.watch();
					stream = attached.watch;
					const snapshot = stream.value;
					const transcript = new ConversationTranscript((query, limit, ctx) => attached.conversation.entries(query, limit, undefined, ctx));
					if (cancelled) return;
					const submission = await turn?.submit();
					if (cancelled) { if (submission) await abort(); return; }
					if (!submit) input = { ...input, runId: await connection.requestIdForInput((snapshot.docs["pi.live"] as LiveState | undefined)?.run?.inputs[0]) ?? input.runId };
					emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
					const present = async (transcript: ConversationTranscript, view: ConversationView, render: (view: TranscriptView) => Promise<void>) => {
						let merged = transcript.merge(view);
						// A slow listener can miss an entire tool round when the bounded window advances.
						for (let gap = merged.items.find((item) => item.kind === "gap"); gap?.kind === "gap" && !cancelled; gap = merged.items.find((item) => item.kind === "gap")) merged = await transcript.fillGap(gap, context);
						if (!cancelled) await render(merged);
					};
					const events = createAgUiEvents(emit, { threadId: input.threadId, submit, replay: Boolean(turn?.existingRequest), optimisticUser, watchChild: async (id) => {
						if (watchedChildren.has(id) || cancelled) return;
						watchedChildren.add(id);
						const attached = await connection.watch(String(id));
						const child = attached.watch;
						childWatches.push(child); checkEnd(child);
						const transcript = new ConversationTranscript((query, limit, ctx) => attached.conversation.entries(query, limit, undefined, ctx));
						await present(transcript, child.value, (view) => events.onChildView(id, view));
						child.start(async (call) => {
							if (call.kind === "failed") throw call.error;
							await present(transcript, call.value, (view) => events.onChildView(id, view));
						});
						const approval = await connection.approvals(String(id));
						if (approval) {
							childWatches.push(approval); checkEnd(approval);
							const show = events.approvals(); show(approval.value);
							approval.start(async (call) => { if (call.kind === "failed") throw call.error; if (!cancelled) show(call.retired ? null : call.value); });
						}
					} });
					const activity = createConversationActivity(snapshot, submission ? { id: submission.id, existedAtSnapshot: Boolean(turn?.existingRequest) } : undefined);
					await present(transcript, snapshot, events.onView);
					stream.start(async (call) => {
						if (call.kind === "failed") throw call.error;
						await present(transcript, call.value, events.onView);
						activity.apply(call.value);
					});
					if (submission) void submission.wait(context).then((record) => activity.settle(("answer" in record ? record.answer : "entry" in record ? record.entry : undefined) as EntryId | undefined), failure.reject);
					approvals = await connection.approvals();
					if (approvals) {
						checkEnd(approvals);
						const show = events.approvals(); show(approvals.value);
						approvals.start(async (call) => { if (call.kind === "failed") throw call.error; if (!cancelled) show(call.retired ? null : call.value); });
					}
					const idle = await Promise.race([
						activity.idle.then(() => true),
						stream.closed.then((end) => { if ("error" in end) throw end.error; return false; }),
						detached.promise.then(() => false),
						failure.promise,
					]);
					if (idle && submission) await this.service.waitForTurn(submission);
					events.close();
					if (!cancelled) { emit({ type: EventType.CUSTOM, name: "loom.history_changed", value: { threadId: input.threadId } }); emit({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId }); }
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
