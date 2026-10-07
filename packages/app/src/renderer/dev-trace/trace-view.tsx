import { createContext, useContext, useMemo, useState } from "react";
import { SpanPrimitive, SpanResource } from "@assistant-ui/react-o11y";
import { AuiConfig, AuiProvider, useAuiState } from "@assistant-ui/store";
import type { LoomTraceSpan } from "@loom/agent";
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
	if (name === "pi.ai.request") return { input: "Sent", output: "Reply" };
	return { input: "Arguments", output: "Result" };
}

function SpanPayload({ span }: { span: LoomTraceSpan }): React.JSX.Element {
	const payload = spanPayload(span);
	if (!payload) return <p className="trace-empty">No payload.</p>;
	const labels = payloadLabels(span.name);
	return (
		<div>
			{payload.input ? (
				<section>
					<h3>{labels.input}</h3>
					<pre>{payload.input}</pre>
				</section>
			) : null}
			{payload.output ? (
				<section>
					<h3>{labels.output}</h3>
					<pre>{payload.output}</pre>
				</section>
			) : null}
		</div>
	);
}

export function TraceTree({ spans }: { spans: readonly LoomTraceSpan[] }): React.JSX.Element | null {
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
				{chosen ? <SpanPayload span={chosen} /> : <p className="trace-empty">Select a span.</p>}
			</div>
		</TraceSelection.Provider>
	);
}
