import { AbstractAgent, type RunAgentInput } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { AgentEventStream, DocumentWatch, PendingToolApproval } from "@loom/agent";
import type { ChatService } from "./chat-service.ts";
import { createAgUiEvents, temporaryMessageId } from "./ag-ui-events.ts";
import { createConversationActivity } from "./conversation-activity.ts";
import { transcriptText } from "../../shared/ag-ui-messages.ts";
import { formatChatError } from "../../shared/chat-error.ts";
import { Observable } from "rxjs";

/** Protocol boundary: durable commit events + Loom approval document -> AG-UI increments. */
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
				let stream: AgentEventStream | undefined;
				let approvals: DocumentWatch<{ pending: PendingToolApproval[] }> | undefined;
				try {
					if (previous) { await previous.abort(); await previous.done; }
					if (cancelled) return;
					const connection = await this.service.connect(input.threadId);
					abort = connection.abort;
					const optimisticUser = input.messages.findLast((message) => message.role === "user");
					const turn = submit ? await connection.prepareTurn(transcriptText(optimisticUser?.content), { requestId: input.runId, clientMessageId: optimisticUser?.id }) : undefined;
					if (cancelled) return;
					stream = await connection.watch();
					if (cancelled) return;
					const submission = await turn?.submit();
					if (cancelled) { if (submission) await abort(); return; }
					if (!submit) input = { ...input, runId: await connection.requestIdForInput(stream.snapshot.run?.inputs[0]) ?? input.runId };
					emit({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
					const events = createAgUiEvents(emit, { threadId: input.threadId, submit, replay: Boolean(turn?.existingRequest), optimisticUser, watchChild: async (id) => {
						if (watchedChildren.has(id)) return;
						watchedChildren.add(id);
						const child = await connection.watch(String(id));
						childWatches.push(child);
						await events.onChildEvent(id, child.snapshot);
						child.start(async (batch) => { for (const event of batch) if (!cancelled) await events.onChildEvent(id, event); });
						const approval = await connection.approvals(String(id));
						if (approval) {
							childWatches.push(approval);
							const show = events.approvals(); show(approval.value);
							approval.start(async (value) => { if (!cancelled) show(value); });
						}
					} });
					const activity = createConversationActivity(stream.snapshot, submission ? { id: submission.id, existedAtSnapshot: Boolean(turn?.existingRequest) } : undefined);
					await events.onEvent(stream.snapshot);
					stream.start(async (batch) => {
						for (const event of batch) if (!cancelled) await events.onEvent(event);
						// Apply the whole commit before checking completion: it may end one run and start another.
						activity.apply(batch);
					});
					approvals = await connection.approvals();
					if (approvals) { const show = events.approvals(); show(approvals.value); approvals.start(async (value) => { show(value); }); }
					const idle = await Promise.race([
						activity.idle.then(() => true),
						stream.closed.then((end) => { if ("error" in end) throw end.error; return false; }),
						detached.promise.then(() => false),
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
