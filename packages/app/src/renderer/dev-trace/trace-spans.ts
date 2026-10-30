import type { LoomTraceSpan } from "@loom/agent";

const SHOWN = new Set(["pi.durable.submit", "pi.durable.phase", "pi.ai.request", "pi.ai.poll", "loom.approval"]);

/** Ledger candidates retain their native objects and parent identities, including absent parents. */
export function visibleSpans(spans: readonly LoomTraceSpan[]): LoomTraceSpan[] {
	return spans.filter((span) => SHOWN.has(span.name));
}
export function spanPayload(span: LoomTraceSpan): { input: string; output: string } | null {
	const input = span.attributes["loom.io.input"], output = span.attributes["loom.io.output"];
	const sent = typeof input === "string" ? input : "", reply = typeof output === "string" ? output : "";
	return sent || reply ? { input: sent, output: reply } : null;
}
export function formatTraceDuration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.max(0, Math.round(ms))}ms`;
}
