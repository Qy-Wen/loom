import type { SpanData } from "@assistant-ui/react-o11y";
import type { LoomTraceSpan } from "@loom/agent";

const SHOWN = new Set([
	"pi.harness.run",
	"pi.harness.turn",
	"pi.harness.step",
	"pi.harness.tool",
	"pi.harness.compaction",
	"pi.harness.navigation",
	"pi.ai.request",
]);

/** Drop hook and session spans, and hang the rest on the nearest kept ancestor. */
export function visibleSpans(spans: readonly LoomTraceSpan[]): LoomTraceSpan[] {
	const byId = new Map(spans.map((span) => [span.id, span]));
	const shown = new Set(spans.filter((span) => SHOWN.has(span.name)).map((span) => span.id));
	const parentOf = (id: number | null): number | null => {
		if (id === null) return null;
		if (shown.has(id)) return id;
		return parentOf(byId.get(id)?.parentId ?? null);
	};
	return spans
		.filter((span) => shown.has(span.id))
		.map((span) => ({ ...span, parentId: parentOf(span.parentId) }));
}

function numberAttr(value: unknown): number {
	return typeof value === "number" ? value : 0;
}

function textAttr(span: LoomTraceSpan, name: string): string | undefined {
	const value = span.attributes[name];
	return typeof value === "string" ? value : undefined;
}

export function spanLabel(span: LoomTraceSpan): string {
	if (span.name === "pi.harness.tool") return textAttr(span, "pi.tool.name") ?? "tool";
	if (span.name === "pi.ai.request") {
		const model = textAttr(span, "pi.ai.model") ?? "model";
		const input = numberAttr(span.attributes["pi.ai.usage.input_tokens"]);
		const output = numberAttr(span.attributes["pi.ai.usage.output_tokens"]);
		return input || output ? `${model} · ${input} in / ${output} out` : model;
	}
	if (span.name === "pi.harness.step") {
		const kind = textAttr(span, "pi.step.kind") ?? "step";
		const attempt = span.attributes["pi.step.attempt"];
		return typeof attempt === "number" ? `${kind} ${attempt}` : kind;
	}
	const short = span.name.split(".").at(-1);
	return short && short.length > 0 ? short : span.name;
}

function spanKind(span: LoomTraceSpan): string {
	if (span.name === "pi.ai.request") return "llm";
	if (span.name === "pi.harness.tool") return "tool";
	if (span.name === "pi.harness.step") return "step";
	return span.name.split(".").at(-1) ?? span.name;
}

/** Convert one prompt's Loom spans into the viewer's span list. */
export function toSpanData(spans: readonly LoomTraceSpan[]): SpanData[] {
	return visibleSpans(spans).map((span) => ({
		id: String(span.id),
		parentSpanId: span.parentId === null ? null : String(span.parentId),
		name: spanLabel(span),
		type: spanKind(span),
		status: span.status.status === "error" ? "failed" : "completed",
		startedAt: span.startedAt,
		endedAt: span.endedAt ?? null,
		latencyMs: span.endedAt === undefined ? null : span.endedAt - span.startedAt,
	}));
}

export function spanPayload(span: LoomTraceSpan): { input: string; output: string } | null {
	const input = textAttr(span, "loom.io.input") ?? "";
	const output = textAttr(span, "loom.io.output") ?? "";
	if (!input && !output) return null;
	return { input, output };
}

export function formatTraceDuration(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
	return `${Math.max(0, Math.round(ms))}ms`;
}

/** One line for a prompt: duration, tokens, and tool names. */
export function traceSummary(spans: readonly LoomTraceSpan[]): string {
	const visible = visibleSpans(spans);
	if (visible.length === 0) return "";
	const start = Math.min(...visible.map((span) => span.startedAt));
	const end = Math.max(...visible.map((span) => span.endedAt ?? span.startedAt));
	let input = 0;
	let output = 0;
	const tools: string[] = [];
	for (const span of visible) {
		if (span.name === "pi.ai.request") {
			input += numberAttr(span.attributes["pi.ai.usage.input_tokens"]);
			output += numberAttr(span.attributes["pi.ai.usage.output_tokens"]);
		}
		if (span.name !== "pi.harness.tool") continue;
		const name = textAttr(span, "pi.tool.name");
		if (name && !tools.includes(name)) tools.push(name);
	}
	const parts = [formatTraceDuration(end - start)];
	if (input || output) parts.push(`${input} in / ${output} out`);
	if (tools.length > 0) parts.push(tools.join(", "));
	return parts.join(" · ");
}
