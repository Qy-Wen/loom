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
/** Local wall-clock display only; native epoch timestamps retain their sub-millisecond precision. */
export function formatTraceTimestamp(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms)) return "未采集";
	const date = new Date(ms);
	if (!Number.isFinite(date.getTime())) return "未采集";
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
export function formatTraceDuration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.max(0, Math.round(ms))}ms`;
}
