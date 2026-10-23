import type { SpanData } from "@assistant-ui/react-o11y";
import type { LoomTraceSpan } from "@loom/agent";

const SHOWN = new Set(["pi.durable.submit", "pi.durable.phase", "pi.ai.request", "pi.ai.poll", "loom.approval"]);

/** Native parents may be absent after recovery or retention; keep those spans visible as roots. */
export function visibleSpans(spans: readonly LoomTraceSpan[]): LoomTraceSpan[] {
	const byId = new Map(spans.map((span) => [span.id, span]));
	const shown = new Set(spans.filter((span) => SHOWN.has(span.name)).map((span) => span.id));
	const parentOf = (id: string | undefined): string | undefined => {
		const seen = new Set<string>();
		while (id && !seen.has(id)) {
			if (shown.has(id)) return id;
			seen.add(id); id = byId.get(id)?.parentId;
		}
		return undefined;
	};
	return spans.filter((span) => shown.has(span.id)).map((span) => ({ ...span, parentId: parentOf(span.parentId) }));
}
function numberAttr(value: unknown): number { return typeof value === "number" ? value : 0; }
function textAttr(span: LoomTraceSpan, name: string): string | undefined {
	const value = span.attributes[name]; return typeof value === "string" ? value : undefined;
}
export function spanLabel(span: LoomTraceSpan): string {
	if (span.name === "loom.approval") return `Approval · ${textAttr(span, "tool.name") ?? "tool"}`;
	if (span.name === "pi.durable.phase") {
		const name = textAttr(span, "tool.name") ?? textAttr(span, "task.name")?.replace("pi.", "") ?? "task";
		const phase = textAttr(span, "phase") ?? "phase";
		const attempt = span.attributes.attempt;
		return `${name} · ${phase}${typeof attempt === "number" ? ` #${attempt}` : ""}`;
	}
	if (span.name === "pi.ai.request" || span.name === "pi.ai.poll") {
		const model = textAttr(span, "model") ?? "model";
		const input = numberAttr(span.attributes["usage.input"]), output = numberAttr(span.attributes["usage.output"]);
		return `${model}${span.name === "pi.ai.poll" ? " · poll" : ""}${input || output ? ` · ${input} in / ${output} out` : ""}`;
	}
	return span.name === "pi.durable.submit" ? "submit" : span.name;
}
function spanKind(span: LoomTraceSpan): string {
	if (span.name === "pi.ai.request" || span.name === "pi.ai.poll") return "llm";
	if (span.name === "pi.durable.phase") return span.attributes["task.name"] === "pi.tool" ? "tool" : "step";
	return span.name.split(".").at(-1) ?? span.name;
}
export function toSpanData(spans: readonly LoomTraceSpan[]): SpanData[] {
	return visibleSpans(spans).map((span) => ({
		id: span.id, parentSpanId: span.parentId ?? null, name: spanLabel(span), type: spanKind(span),
		status: span.interrupted || span.status.status === "error" ? "failed" : span.endedMs === undefined ? "running" : "completed",
		startedAt: span.startedMs, endedAt: span.endedMs ?? null,
		latencyMs: span.endedMs === undefined ? null : span.endedMs - span.startedMs,
	}));
}
export function spanPayload(span: LoomTraceSpan): { input: string; output: string } | null {
	const input = textAttr(span, "loom.io.input") ?? "", output = textAttr(span, "loom.io.output") ?? "";
	return input || output ? { input, output } : null;
}
export function formatTraceDuration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.max(0, Math.round(ms))}ms`;
}
export function traceSummary(spans: readonly LoomTraceSpan[]): string {
	const visible = visibleSpans(spans); if (!visible.length) return "";
	const start = Math.min(...visible.map((span) => span.startedMs));
	const end = Math.max(...visible.map((span) => span.endedMs ?? span.startedMs));
	let input = 0, output = 0;
	const tools = new Set<string>();
	for (const span of visible) {
		if ((span.name === "pi.ai.request" || span.name === "pi.ai.poll") && span.attributes.stop !== "pending" && span.attributes.stop !== "deferred") {
			input += numberAttr(span.attributes["usage.input"]); output += numberAttr(span.attributes["usage.output"]);
		}
		if (span.name === "pi.durable.phase" && typeof span.attributes["tool.name"] === "string") tools.add(span.attributes["tool.name"]);
	}
	const parts = [formatTraceDuration(end - start)];
	if (input || output) parts.push(`${input} in / ${output} out`);
	if (tools.size) parts.push([...tools].join(", "));
	return parts.join(" · ");
}
