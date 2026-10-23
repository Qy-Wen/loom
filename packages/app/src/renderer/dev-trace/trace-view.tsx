import { createContext, useContext, useMemo, useState } from "react";
import { SpanPrimitive, SpanResource } from "@assistant-ui/react-o11y";
import { AuiConfig, AuiProvider, useAuiState } from "@assistant-ui/store";
import type { LoomTraceSpan } from "@loom/agent";
import { splitTraceBlobs } from "@loom/agent/trace-blob";
import { formatTraceDuration, spanPayload, toSpanData } from "./trace-spans.ts";

const TraceSelection = createContext<{ selected: string | null; select: (id: string) => void }>({
	selected: null,
	select: () => undefined,
});

function SpanDuration(): React.JSX.Element {
	const latency = useAuiState((state) => state.span.latencyMs);
	return <span className="trace-ms">{latency === null ? "" : formatTraceDuration(latency)}</span>;
}

function TraceRow(): React.JSX.Element {
	const id = useAuiState((state) => state.span.id);
	const selection = useContext(TraceSelection);
	return (
		<div
			className={id === selection.selected ? "trace-row is-selected" : "trace-row"}
			onClick={() => selection.select(id)}
		>
			<SpanPrimitive.Root className="trace-span">
				<SpanPrimitive.Indent />
				<SpanPrimitive.CollapseToggle className="trace-toggle">▸</SpanPrimitive.CollapseToggle>
				<SpanPrimitive.Name className="trace-name" />
				<SpanDuration />
			</SpanPrimitive.Root>
			<div className="trace-track">
				<SpanPrimitive.TimelineBar className="trace-bar" />
			</div>
		</div>
	);
}

function payloadLabels(name: string): { input: string; output: string } {
	if (name === "pi.ai.request" || name === "pi.ai.poll") return { input: "Sent", output: "Reply" };
	return { input: "Arguments", output: "Result" };
}

/** Text that may contain previews of long texts; each preview expands to its full text from the record's blobs. */
function PayloadText({ text, blobs }: { text: string; blobs: Readonly<Record<string, string>> | undefined }): React.JSX.Element {
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	const parts = splitTraceBlobs(text);
	return (
		<pre>
			{parts.map((part, index) => {
				if ("text" in part) return part.text;
				const full = blobs?.[part.hash];
				if (full === undefined) return <span key={index} className="trace-blob-missing">[full text unavailable]</span>;
				const key = `${index}:${part.hash}`;
				const expanded = open.has(key);
				return (
					<span key={index}>
						{expanded ? <span className="trace-blob-full">{"\n"}{full}{"\n"}</span> : null}
						<button
							type="button"
							className="trace-blob-toggle"
							onClick={() => setOpen((prev) => { const next = new Set(prev); if (!next.delete(key)) next.add(key); return next; })}
						>
							{expanded ? "Collapse" : `Expand (${part.length.toLocaleString()} chars)`}
						</button>
					</span>
				);
			})}
		</pre>
	);
}

function SpanPayload({ span, blobs }: { span: LoomTraceSpan; blobs: Readonly<Record<string, string>> | undefined }): React.JSX.Element {
	const payload = spanPayload(span);
	const labels = payloadLabels(span.name);
	return (
		<div>
			{span.name === "pi.ai.request" || span.name === "pi.ai.poll" ? <p className="trace-empty">
				Cache read: {String(span.attributes["usage.cache_read"] ?? 0)} · Cache write: {String(span.attributes["usage.cache_write"] ?? 0)}
			</p> : null}
			{payload?.input ? (
				<section>
					<h3>{labels.input}</h3>
					<PayloadText text={payload.input} blobs={blobs} />
				</section>
			) : null}
			{payload?.output ? (
				<section>
					<h3>{labels.output}</h3>
					<pre>{payload.output}</pre>
				</section>
			) : null}
			{typeof span.attributes["loom.tool.duration_ms"] === "number" ? <p className="trace-empty">Execution: {formatTraceDuration(span.attributes["loom.tool.duration_ms"])}</p> : null}
			<details><summary>Metadata and events</summary><pre>{JSON.stringify({ attributes: Object.fromEntries(Object.entries(span.attributes).filter(([key]) => !key.startsWith("loom.io."))), status: span.status, interrupted: span.interrupted, events: span.events, links: span.links }, null, 2)}</pre></details>
		</div>
	);
}

export function TraceTree({ spans, blobs }: { spans: readonly LoomTraceSpan[]; blobs?: Readonly<Record<string, string>> }): React.JSX.Element | null {
	const [selected, setSelected] = useState<string | null>(null);
	const data = useMemo(() => toSpanData(spans), [spans]);
	const config = useMemo(
		() => (data.length === 0 ? null : AuiConfig({ span: SpanResource({ spans: data }) })),
		[data],
	);
	const selection = useMemo(() => ({ selected, select: setSelected }), [selected]);
	if (!config || data.length === 0) return null;
	const start = Math.min(...data.map((span) => span.startedAt));
	const end = Math.max(...data.map((span) => span.endedAt ?? span.startedAt));
	const chosen = spans.find((span) => String(span.id) === selected) ?? null;
	return (
		<TraceSelection.Provider value={selection}>
			<div className="trace-tree">
				<AuiProvider extends={null} config={config}>
					<SpanPrimitive.Timeline timeRange={{ min: start, max: Math.max(end, start + 1) }}>
						<SpanPrimitive.Children components={{ Span: TraceRow }} />
					</SpanPrimitive.Timeline>
				</AuiProvider>
			</div>
			<div className="trace-io">
				{chosen ? <SpanPayload span={chosen} blobs={blobs} /> : <p className="trace-empty">Select a span.</p>}
			</div>
		</TraceSelection.Provider>
	);
}
