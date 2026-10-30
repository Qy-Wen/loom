import type { Models } from "@earendil-works/pi-ai/models";
import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { defineExtension, CompactionTask, ToolTask, hook, type Harness } from "../durable-adapter.ts";
import { TraceStore, type LoomTraceRecord, type LoomTraceStatus } from "./trace-store.ts";
import { TracePrivacy } from "./trace-privacy.ts";
import { LiveTelemetry } from "./trace-recorder.ts";
import { traceModels } from "./trace-models.ts";

/** Assemble the native telemetry recorder and optional, redacted Loom content. */
export class DurableTrace {
	readonly privacy = new TracePrivacy();
	readonly telemetry: LiveTelemetry;
	readonly store: TraceStore;
	private readonly secrets = new Set<string>();
	private unsubscribe?: () => void;
	constructor(store: TraceStore, publish: (record: LoomTraceRecord) => void = () => {}, report: (error: unknown) => void = () => {}) {
		this.store = store;
		this.telemetry = new LiveTelemetry(store, this.privacy, { publish, report, summarize: traceStatus });
	}
	setSecrets(values: readonly string[]): void {
		for (const value of values) if (value) this.secrets.add(value);
		this.privacy.setSecrets([...this.secrets]);
	}
	readonly extension = defineExtension({ name: "loom.trace", hooks: [
		hook(CompactionTask, { beforeCompact: (_request, api, context) => {
			context.telemetry.setAttributes({ "conversation.id": api.conversationId }); return undefined;
		} }),
		hook(ToolTask, {
			beforeTool: (call, api, context) => {
				context.telemetry.setAttributes({ "conversation.id": api.conversationId });
				this.capture(() => this.telemetry.content(context.telemetry, { "loom.io.input": this.privacy.value(call.arguments) })); return undefined;
			},
			afterTool: (_call, result, _api, context) => {
				this.capture(() => this.telemetry.content(context.telemetry, { "loom.io.output": this.privacy.value(result), "loom.tool.is_error": result.isError ?? false })); return undefined;
			},
		}),
	] });
	models(models: Models): Models {
		return traceModels(models, { start: (parent, messages) => {
			if (!parent) return undefined;
			let request: TelemetrySpan | undefined;
			let lastUpdate = 0;
			const telemetry: TelemetrySpan = { ...parent, startSpan: (options, callback) => parent.startSpan(options, (span) => {
				if (options.name === "pi.ai.request" || options.name === "pi.ai.poll") {
					request = span;
					this.capture(() => {
						const blobs: Record<string, string> = {};
						const input = this.privacy.request(messages, (hash, text) => { blobs[hash] = text; });
						this.telemetry.content(span, { "loom.io.input": input }, blobs); this.flush();
					});
				}
				return callback(span);
			}) };
			const output = (content: unknown) => { if (request) this.telemetry.content(request, { "loom.io.output": this.privacy.value(content) }); };
			return {
				telemetry,
				partial: (message) => {
					if (!message.content.length || Date.now() - lastUpdate < 100) return;
					lastUpdate = Date.now(); output(message.content);
				},
				end: (message) => { output(message.content); this.flush(); },
				error: (error) => { output(error instanceof Error ? error.message : String(error)); this.flush(); },
			};
		} });
	}
	/** Add committed result content and submission summaries; all span identities and lifetimes stay native. */
	attach(harness: Harness): void {
		this.unsubscribe?.();
		this.unsubscribe = harness.subscribeCommits((publication, context) => this.capture(() => {
			for (const change of publication.changes) {
				if (change.type === "submission" && change.value.type === "input" && (change.value.status === "done" || change.value.status === "unanswered")) {
					const submission = change.value;
					const trace = this.store.forSubmission(submission.id);
					if (trace) this.telemetry.updateTrace(trace.id, (record) => {
						record.settlement = submission.status;
						record.settlementReason = submission.reason;
					});
				}
				if (change.type !== "entry") continue;
				const message = change.value.model?.[0];
				if (message?.role !== "toolResult") continue;
				this.telemetry.content(context.telemetry, {
					"loom.io.output": this.privacy.value(message.content), "loom.tool.is_error": message.isError,
					...(message.durationMs === undefined ? {} : { "loom.tool.duration_ms": message.durationMs }),
				});
			}
		}));
	}
	flush(): void { this.telemetry.flush(); }
	stop(): void { this.unsubscribe?.(); this.telemetry.stop(); }
	private capture(operation: () => void): void { try { operation(); } catch {} }
}

/** Submission completion and durable waits are application summaries, not span lifetimes. */
function traceStatus(record: LoomTraceRecord): LoomTraceStatus {
	if (record.settlement === "done") return "completed";
	if (record.settlement === "unanswered") return record.settlementReason === "aborted" ? "aborted" : "error";
	if (record.spans.some((span) => span.endedMs === undefined)) return "running";
	if (record.spans.some((span) => span.name === "pi.durable.submit" && span.attributes["submission.type"] === "input")) return "running";
	const phase = record.spans.findLast((span) => span.name === "pi.durable.phase");
	const outcome = String(phase?.attributes.outcome ?? "");
	if (outcome === "waiting" || outcome === "sleeping" || outcome.startsWith("next=")) return "running";
	return record.spans.some((span) => span.status.status === "error") ? "error" : "completed";
}
