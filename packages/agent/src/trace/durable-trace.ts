import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import {
	defineExtension, GenerationTask, CompactionTask, ToolTask, hook,
	LiveDoc,
	type CommitPublication, type ConversationRecord, type Harness, type HookApi,
	type TaskRecord, type LiveState, type ToolTaskInput,
} from "../durable-adapter.ts";
import type { LoomTraceSpan } from "./trace-types.ts";
import { TraceStore, type LoomTraceRecord, type LoomTraceStatus } from "./trace-store.ts";
import { TracePrivacy } from "./trace-privacy.ts";
import { traceModels } from "./trace-models.ts";

type TaskRow = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Span = { -readonly [K in keyof LoomTraceSpan]: LoomTraceSpan[K] };
type ActiveTrace = { record: LoomTraceRecord; spans: Map<string, Span>; dirty: boolean };

/** Diagnostics only: observes native work, never schedules, retries, or changes model context. */
export class DurableTrace {
	readonly privacy = new TracePrivacy();
	private readonly traces = new Map<string, ActiveTrace>();
	private readonly tasks = new Map<number, TaskRow>();
	private readonly taskTrace = new Map<number, ActiveTrace>();
	private readonly conversations = new Map<number, ConversationRecord>();
	private readonly live = new Map<number, LiveState>();
	private readonly signals = new WeakMap<AbortSignal, number>();
	private readonly requests = new Map<number, Span>();
	private timer?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;
	private stopped = false;
	private requestSequence = 0;
	private readonly pending: Array<{ publication: CommitPublication; context: Context }> = [];

	readonly store: TraceStore;
	private readonly publish: (record: LoomTraceRecord) => void;
	private readonly report: (error: unknown) => void;
	constructor(store: TraceStore, publish: (record: LoomTraceRecord) => void = () => {}, report: (error: unknown) => void = () => {}) { this.store = store; this.publish = publish; this.report = report; }
	private readonly secrets = new Set<string>();
	setSecrets(values: readonly string[]) { for (const value of values) if (value) this.secrets.add(value); this.privacy.setSecrets([...this.secrets]); }
	readonly extension = defineExtension({ name: "loom.trace", hooks: [
		hook(GenerationTask, { beforeRequest: (_request, api, context) => { this.bind(api, context); return undefined; } }),
		hook(CompactionTask, { beforeCompact: (_request, api, context) => { this.bind(api, context); return undefined; } }),
		hook(ToolTask, { beforeTool: (call, api, context) => {
			this.bind(api, context);
			this.changeTaskSpan(api.taskId, { "loom.io.input": this.privacy.value(call.arguments), "pi.tool.name": call.name, "pi.tool.call_id": call.id });
			return undefined;
		}, afterTool: (_call, result, api) => {
			this.drain();
			this.changeTaskSpan(api.taskId, { "loom.io.output": this.privacy.value(result), "pi.tool.is_error": result.isError ?? false });
			return undefined;
		} }),
	] });

	models(models: Models): Models {
		return traceModels(models, { start: (signal, model, messages, operation) => {
			this.drain();
			const task = signal && this.signals.get(signal);
			if (task === undefined || this.stopped) return undefined;
			const span = this.requests.get(task) ?? this.request(task, messages);
			if (!span) return undefined;
			span.attributes = { ...span.attributes, "pi.ai.model": model.id, "pi.ai.provider": model.provider, "pi.ai.api": model.api, "pi.ai.operation": operation };
			this.flush();
			let lastUpdate = 0;
			return {
				partial: (message) => {
					if (this.stopped || !message.content.length || Date.now() - lastUpdate < 100) return;
					lastUpdate = Date.now();
					span.attributes = { ...span.attributes, "loom.io.output": this.privacy.value(message.content), "loom.first_content_ms": span.attributes["loom.first_content_ms"] ?? lastUpdate - span.startedAt };
					const trace = this.taskTrace.get(task); if (trace) this.dirty(trace);
				},
				end: (message) => this.response(task, span, message),
				error: (error) => this.requestError(task, span, error),
			};
		} });
	}

	async start(harness: Harness): Promise<void> {
		// Paused owner: hydrate immutable identity/ownership before recovery starts.
		await harness.commit(async (tx) => {
			let cursor;
			do {
				const page = await tx.scanConversations({}, 256, cursor);
				for (const row of page.items) {
					this.conversations.set(row.id, row);
				}
				cursor = page.next;
			} while (cursor !== undefined);
		}, BACKGROUND_CONTEXT);
		for (const row of this.conversations.values()) {
			const live = await harness.snapshot(LiveDoc, row.id, BACKGROUND_CONTEXT);
			if (live) this.live.set(row.id, live);
		}
		for (const row of this.store.unfinished()) {
			for (const span of row.spans) if (span.endedAt === undefined) {
				(span as Span).endedAt = Date.now();
				(span as Span).attributes = { ...span.attributes, "loom.outcome": "interrupted" };
				(span as Span).status = { status: "error", error: { name: "Interrupted", message: "Process ended before this span settled" } };
			}
			row.status = "interrupted"; row.revision++;
			this.store.save(row);
		}
		const inspection = await harness.inspect(BACKGROUND_CONTEXT);
		for (const { record } of inspection.tasks) this.tasks.set(record.id, record);
		for (const { record } of [...inspection.tasks].sort((a, b) => a.record.id - b.record.id)) this.taskSpan(record);
		this.unsubscribe = harness.subscribeCommits((publication, context) => {
			this.pending.push({ publication, context });
			queueMicrotask(() => {
				this.drain();
				if ([...this.traces.values()].some((trace) => trace.dirty && trace.record.status !== "running")) this.flush();
			});
		});
		this.flush();
	}

	private load(id: string): ActiveTrace | undefined {
		const existing = this.traces.get(id); if (existing) return existing;
		const record = this.store.get(id); if (!record) return undefined;
		const trace: ActiveTrace = { record, spans: new Map(record.spans.map((span) => [String(span.attributes["loom.key"]), span as Span])), dirty: false };
		this.traces.set(id, trace); return trace;
	}
	private bind(api: HookApi, context: Context): void { this.drain(); if (context.abortSignal) this.signals.set(context.abortSignal, api.taskId); }
	private traceFor(conversationId: number): ActiveTrace | undefined {
		const owner = this.conversations.get(conversationId)?.owner;
		if (owner) return this.taskTrace.get(owner.taskId) ?? (this.tasks.get(owner.taskId) && this.taskSpan(this.tasks.get(owner.taskId)!)?.trace);
		const input = this.live.get(conversationId)?.run?.inputs[0];
		if (input === undefined) return undefined;
		const id = `run:${input}`;
		let trace = this.load(id);
		if (!trace) {
			trace = { record: { id, threadId: String(conversationId), at: Date.now(), revision: 0, status: "running", spans: [] }, spans: new Map(), dirty: true };
			this.traces.set(id, trace);
		}
		if (trace.record.status === "interrupted") {
			trace.record.status = "running";
			const run = trace.spans.get("run");
			if (run) { run.endedAt = undefined; run.status = { status: "ok" }; run.attributes = { ...run.attributes, "loom.outcome": "running", "loom.recovered": true }; }
		}
		this.span(trace, "run", "pi.harness.run", null, { "loom.conversation_id": conversationId, "loom.submission_id": input }, trace.record.at);
		return trace;
	}
	private span(trace: ActiveTrace, key: string, name: string, parentId: number | null, attributes: SpanAttributes = {}, startedAt = Date.now()): Span {
		let span = trace.spans.get(key);
		if (!span) {
			span = { id: trace.record.spans.length + 1, parentId, name, attributes: { "loom.key": key, ...this.privacy.attributes(attributes) }, status: { status: "ok" }, startedAt };
			trace.spans.set(key, span); trace.record.spans.push(span); this.dirty(trace);
		}
		return span;
	}
	private taskSpan(task: TaskRow): { trace: ActiveTrace; span: Span } | undefined {
		const independentCompaction = task.kind === "pi.compaction" && task.owner === undefined;
		let trace = this.taskTrace.get(task.id) ?? (!task.background && !independentCompaction ? this.traceFor(task.conversationId) : undefined);
		// Manual/background compaction without a user run gets its own record.
		if (!trace && task.kind === "pi.compaction") {
			const id = `compaction:${task.id}`;
			trace = this.load(id);
			if (!trace) { trace = { record: { id, threadId: String(task.conversationId), at: task.startedAt ?? Date.now(), revision: 0, status: "running", spans: [] }, spans: new Map(), dirty: true }; this.traces.set(id, trace); }
		}
		if (!trace) return undefined;
		this.taskTrace.set(task.id, trace);
		let parent = trace.spans.get("run")?.id ?? null;
		const parentTask = task.owner ?? this.conversations.get(task.conversationId)?.owner?.taskId;
		if (parentTask !== undefined) parent = trace.spans.get(`task:${parentTask}`)?.id ?? parent;
		const name = task.kind === "pi.tool" ? "pi.harness.tool" : task.kind === "pi.compaction" ? "pi.harness.compaction" : "pi.harness.turn";
		const span = this.span(trace, `task:${task.id}`, name, parent, { "loom.task_id": task.id, "loom.conversation_id": task.conversationId, "loom.task_kind": task.kind }, task.startedAt);
		if (task.startedAt !== undefined) span.startedAt = task.startedAt;
		if (task.kind === "pi.tool") {
			const input = task.input as ToolTaskInput;
			span.attributes = { ...span.attributes, "pi.tool.call_id": input.kind === "nested" ? input.call.id : input.callId, ...(input.kind === "nested" ? { "pi.tool.name": input.call.name, "loom.io.input": this.privacy.value(input.call.arguments) } : {}) };
		}
		return { trace, span };
	}
	private changeTaskSpan(taskId: number, attributes: SpanAttributes) {
		const trace = this.taskTrace.get(taskId); const span = trace?.spans.get(`task:${taskId}`);
		if (trace && span) { span.attributes = { ...span.attributes, ...this.privacy.attributes(attributes) }; this.dirty(trace); }
	}
	private request(taskId: number, messages: readonly Message[]): Span | undefined {
		const trace = this.taskTrace.get(taskId); const parent = trace?.spans.get(`task:${taskId}`);
		if (!trace || !parent || this.stopped) return undefined;
		const span = this.span(trace, `request:${taskId}:${Date.now()}:${++this.requestSequence}`, "pi.ai.request", parent.id, { "loom.io.input": this.privacy.request(messages, (hash, text) => { trace.record.blobs ??= {}; trace.record.blobs[hash] ??= text; }), "loom.task_id": taskId });
		this.requests.set(taskId, span);
		return span;
	}
	private response(taskId: number, span: Span, message: AssistantMessage) {
		if (this.stopped) return;
		const attributes: SpanAttributes = { "pi.ai.stop_reason": message.stopReason, "loom.io.output": this.privacy.value(message.content), "pi.ai.response.id": message.responseId, "pi.ai.response.model": message.responseModel, "pi.ai.duration_ms": message.durationMs };
		const usageKeys: Record<string, string> = { input: "input_tokens", output: "output_tokens", cacheRead: "cache_read_tokens", cacheWrite: "cache_write_tokens", totalTokens: "total_tokens", reasoning: "reasoning_tokens" };
		for (const [key, value] of Object.entries(message.usage)) if (typeof value === "number") attributes[`pi.ai.usage.${usageKeys[key] ?? key}`] = value;
		span.attributes = { ...span.attributes, ...this.privacy.attributes(attributes) };
		this.end(span, message.stopReason === "error" || message.stopReason === "aborted" ? message.stopReason : "completed", message.errorMessage);
		if (this.requests.get(taskId) === span) this.requests.delete(taskId);
		const trace = this.taskTrace.get(taskId); if (trace) this.dirty(trace);
	}
	private requestError(taskId: number, span: Span, error: unknown) { if (this.stopped) return; this.end(span, "error", error instanceof Error ? error.message : String(error)); this.requests.delete(taskId); const trace = this.taskTrace.get(taskId); if (trace) this.dirty(trace); }
	private end(span: Span, status: LoomTraceStatus, error?: string, endedAt = Date.now()) {
		span.endedAt ??= endedAt;
		span.attributes = { ...span.attributes, "loom.outcome": status };
		if (status !== "completed") span.status = { status: "error", error: { name: status, message: this.privacy.text(error ?? status) } };
	}
	private commit(publication: CommitPublication, context: Context): void {
		if (this.stopped) return;
		// Changes are unordered: ownership/live state must be available before task attribution.
		for (const change of publication.changes) {
			if (change.type === "conversation") this.conversations.set(change.value.id, change.value);
			if (change.type === "task") this.tasks.set(change.value.id, change.value);
			if (change.type === "document" && change.conversationId !== undefined && change.value) {
				if (change.record.kind === "pi.live") this.live.set(change.conversationId, change.value as LiveState);
			}
		}
		for (const task of publication.changes.filter((change) => change.type === "task").map((change) => change.value).sort((a, b) => a.id - b.id)) {
			const attached = this.taskSpan(task); if (!attached) continue;
			const { trace, span } = attached;
			if (task.state.status === "running" && context.abortSignal) this.signals.set(context.abortSignal, task.id);
			if (task.state.status === "running" || task.state.status === "pending" || task.state.status === "waiting") {
				if (span.attributes["loom.outcome"] === "interrupted") {
					span.endedAt = undefined; span.status = { status: "ok" }; span.attributes = { ...span.attributes, "loom.outcome": "running", "loom.recovered": true }; trace.record.status = "running";
				}
				const checkpoint = task.state.checkpoint as Record<string, JsonValue>;
				if (checkpoint.phase === "execute") this.changeTaskSpan(task.id, { "pi.tool.replay": String(checkpoint.replay), "loom.io.input": this.privacy.value(checkpoint.arguments) });
				if (checkpoint.phase === "retry") {
					const retry = this.span(trace, `retry:${task.id}:${checkpoint.attempt}`, "pi.harness.step", span.id, { "pi.step.kind": "retry", "pi.step.attempt": Number(checkpoint.attempt) });
					if (typeof checkpoint.until === "number") retry.attributes = { ...retry.attributes, "loom.retry_until": checkpoint.until };
				} else for (const retry of trace.record.spans.filter((span) => span.parentId === attached.span.id && span.name === "pi.harness.step" && span.endedAt === undefined)) this.end(retry as Span, "completed");
			} else {
				const outcome = task.state.outcome;
				const status = outcome.status === "completed" && span.attributes["pi.tool.is_error"] !== true ? "completed" : outcome.status === "aborted" ? "aborted" : "error";
				const error = "error" in outcome ? outcome.error?.message : "reason" in outcome ? outcome.reason : undefined;
				this.end(span, status, error, task.endedAt);
				if (task.endedAt !== undefined) span.endedAt = task.endedAt;
				for (const child of trace.record.spans) if (child.parentId === span.id && child.endedAt === undefined) this.end(child as Span, child.name === "pi.ai.request" && status === "completed" ? "interrupted" : status, error);
				this.requests.delete(task.id);
				if (trace.record.id === `compaction:${task.id}`) trace.record.status = status;
			}
			this.dirty(trace);
		}
		for (const change of publication.changes) {
			if (change.type === "entry") {
				const message = change.value.model?.[0]; const taskId = change.value.byTaskId;
				if (message?.role === "toolResult" && taskId !== undefined) {
					this.changeTaskSpan(taskId, { "pi.tool.name": message.toolName, "pi.tool.is_error": message.isError, "loom.io.output": this.privacy.value(message.content), "pi.tool.duration_ms": message.durationMs });
					const span = this.taskTrace.get(taskId)?.spans.get(`task:${taskId}`);
					if (span && message.isError) this.end(span, "error", "Tool returned an error");
				}
			}
			if (change.type === "document" && change.record.kind === "loom.approvals" && change.conversationId !== undefined) {
				const trace = this.traceFor(change.conversationId); if (!trace) continue;
				const pending = (change.value?.pending ?? []) as Array<{ toolCallId: string; toolName: string }>;
				for (const row of pending) {
					if (trace.record.spans.some((span) => span.name === "loom.approval" && span.endedAt === undefined && span.attributes["pi.tool.call_id"] === row.toolCallId)) continue;
					const task = [...this.tasks.values()].find((task) => task.conversationId === change.conversationId && task.kind === "pi.tool" && `${task.conversationId}/${(task.input as ToolTaskInput).kind === "model" ? (task.input as { callId: string }).callId : (task.input as { call: { id: string } }).call.id}` === row.toolCallId);
					this.span(trace, `approval:${row.toolCallId}:${task?.id ?? "unknown"}:${Date.now()}`, "loom.approval", task ? trace.spans.get(`task:${task.id}`)?.id ?? null : null, { "pi.tool.name": row.toolName, "pi.tool.call_id": row.toolCallId, "loom.conversation_id": change.conversationId });
				}
				for (const wait of trace.record.spans.filter((span) => span.name === "loom.approval" && span.attributes["loom.conversation_id"] === change.conversationId && span.endedAt === undefined)) if (!pending.some((row) => row.toolCallId === wait.attributes["pi.tool.call_id"])) this.end(wait as Span, "completed");
				this.dirty(trace);
			}
			if (change.type === "submission" && change.value.type === "input" && (change.value.status === "done" || change.value.status === "unanswered")) {
				const trace = this.traces.get(`run:${change.value.id}`); if (!trace) continue;
				trace.record.status = change.value.status === "done" ? "completed" : change.value.reason === "aborted" ? "aborted" : "error";
				const run = trace.spans.get("run"); if (run) this.end(run, trace.record.status);
				this.dirty(trace);
			}
		}
	}
	private drain(): void {
		for (const { publication, context } of this.pending.splice(0)) {
			try { this.commit(publication, context); } catch (error) { this.report(error); }
		}
	}
	private dirty(trace: ActiveTrace) { trace.dirty = true; if (!this.timer && !this.stopped) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 100); }
	flush(): void {
		this.drain();
		for (const trace of this.traces.values()) if (trace.dirty) {
			try {
				trace.record.revision++; this.store.save(trace.record); trace.dirty = false; this.publish(structuredClone(trace.record));
				if (trace.record.status !== "running" && ![...this.taskTrace].some(([id, owner]) => owner === trace && this.tasks.get(id)?.state.status !== "terminal")) {
					this.traces.delete(trace.record.id);
					for (const [id, owner] of this.taskTrace) if (owner === trace) { this.taskTrace.delete(id); this.tasks.delete(id); this.requests.delete(id); }
				}
			} catch (error) { this.report(error); }
		}
	}
	stop(): void {
		if (this.stopped) return;
		this.unsubscribe?.(); this.drain(); clearTimeout(this.timer); this.stopped = true;
		for (const trace of this.traces.values()) if (trace.record.status === "running") {
			trace.record.status = "interrupted";
			for (const span of trace.record.spans) if (span.endedAt === undefined) this.end(span as Span, "interrupted");
			trace.dirty = true;
		}
		this.flush(); this.store.close();
	}
}
