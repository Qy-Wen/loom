import { useEffect, useMemo, useRef, useState } from "react";
import type { DevTraceRecord } from "../../shared/dev-trace.ts";
import { TracePayload } from "./json-view.tsx";
import { TraceSplit } from "./trace-split.tsx";
import { EventPreview, SystemTools } from "./trace-preview.tsx";
import { TraceTimeline, type FocusRange } from "./trace-timeline.tsx";
import { eventForSpan, eventStatus, traceTurns, type TraceEvent } from "./trace-events.ts";
import { useTraceLocale } from "./trace-locale.tsx";
import { traceStatus } from "./trace-messages.ts";
import { timelineLayout } from "./trace-timeline-layout.ts";
import { formatTraceDuration, formatTraceTimestamp, spanPayload } from "./trace-spans.ts";

function TraceTimestamp({ ms }: { ms: number | undefined }): React.JSX.Element {
	const { t } = useTraceLocale();
	const text = formatTraceTimestamp(ms);
	if (ms === undefined || text === undefined) return <>{t.notRecorded}</>;
	const iso = new Date(ms).toISOString();
	return <time dateTime={iso} title={iso}>{text}</time>;
}

export type TraceDetailTab = "overview" | "preview" | "raw";

function EventDetails({ event, location, tab, onTabChange, openTrace }: {
	event: TraceEvent; location: string; tab: TraceDetailTab; onTabChange(tab: TraceDetailTab): void;
	openTrace(id: string, span?: string): Promise<void>;
}): React.JSX.Element {
	const { t } = useTraceLocale();
	const v = t.view;
	const [error, setError] = useState("");
	const [nativeOpen, setNativeOpen] = useState(false);
	const payload = event.marker ? null : spanPayload(event.span);
	const captured = event.rawContent ?? (event.text === undefined ? undefined : JSON.stringify(event.text));
	const attributes = event.span.attributes;
	const first = event.span.events.find((row) => row.name === "pi.ai.first_chunk")?.timeMs;
	const go = (id: string, span?: string) => { setError(""); void openTrace(id, span).catch(() => setError(t.referenceUnavailable)); };
	return <>
		<div className="trace-detail-tabs" role="tablist" aria-label={v.details}>
			{(["overview", "preview", "raw"] as const).map((id) => [id, v.tabs[id]] as const).map(([id, name]) => <button type="button" role="tab" key={id} id={`trace-event-${id}`} aria-controls="trace-event-panel" aria-selected={tab === id} onClick={() => onTabChange(id)}>{name}</button>)}
		</div>
		<div className="trace-io" id="trace-event-panel" role="tabpanel" aria-labelledby={`trace-event-${tab}`}>
			{event.kind === "system" ? <p className="trace-note">{v.systemNote}</p> : null}
			{tab === "preview" ? <EventPreview event={event} /> : tab === "raw" ? <>
				<p className="trace-note">{v.rawNote}</p>
				{captured !== undefined ? <section><h3>{event.kind === "system" ? v.promptBody : v.content}</h3><TracePayload text={captured} blobs={event.record.blobs} /></section> : null}
				{event.kind === "system" ? <SystemTools event={event} /> : null}
				{payload?.input ? <section><h3>{event.kind === "assistant" ? v.sent : v.arguments}</h3><TracePayload text={payload.input} blobs={event.record.blobs} /></section> : null}
				{payload?.output ? <section><h3>{event.kind === "assistant" ? v.reply : v.result}</h3><TracePayload text={payload.output} blobs={event.record.blobs} /></section> : null}
				<section><h3>{event.marker ? v.sourceMetadata : v.metadata}</h3><TracePayload text={JSON.stringify({ ...event.span, attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith("loom.io."))) })} /></section>
				<details className="trace-native" open={nativeOpen} onToggle={(toggle) => setNativeOpen(toggle.currentTarget.open)}><summary>{v.native(event.record.spans.length)}</summary>{nativeOpen ? <><p className="trace-note">{v.nativeNote}</p><TracePayload text={JSON.stringify(event.record.spans)} blobs={event.record.blobs} /></> : null}</details>
			</> : <>
				<dl className="trace-facts">
					<dt>{v.facts.location}</dt><dd>{location}</dd><dt>{v.facts.status}</dt><dd>{traceStatus(t, eventStatus(event))}</dd>
					<dt>{event.marker ? v.facts.sourceCall : v.facts.event}</dt><dd>{event.span.name}</dd>
					<dt>{event.marker ? v.facts.sourceStart : v.facts.start}</dt><dd><TraceTimestamp ms={event.span.startedMs} /></dd>
					<dt>{event.marker ? v.facts.sourceEnd : v.facts.end}</dt><dd>{event.span.endedMs === undefined ? event.span.interrupted ? v.facts.endUnknownInterrupted : v.facts.endRunning : <><TraceTimestamp ms={event.span.endedMs} />{event.span.interrupted ? v.facts.backfilled : ""}</>}</dd>
					<dt>{v.facts.duration}</dt><dd>{event.marker ? v.facts.noDuration : event.span.interrupted ? v.facts.durationUnknown : event.span.endedMs === undefined ? v.facts.running : formatTraceDuration(event.span.endedMs - event.span.startedMs)}</dd>
					{typeof first === "number" && event.kind === "assistant" ? <><dt>{v.facts.firstChunk}</dt><dd>{formatTraceDuration(first)}</dd></> : null}
					{["provider", "model", "usage.input", "usage.output", "usage.cache_read", "usage.cache_write", "cost.total", "phase", "attempt", "outcome"].filter((key) => attributes[key] !== undefined).map((key) => <div className="trace-fact" key={key}><dt>{key}</dt><dd>{String(attributes[key])}</dd></div>)}
					<dt>Trace ID</dt><dd>{event.record.id}</dd><dt>Span ID</dt><dd>{event.span.id}</dd>
				</dl>
				<p className="trace-note">{v.timeNote}{event.marker ? v.sentenceGap + v.snapshotNote : ""}{event.span.interrupted ? v.sentenceGap + v.backfilledNote : ""}</p>
				{event.span.status.status === "error" ? <p className="trace-error">{event.span.status.error?.message ?? v.failed}</p> : null}
				{event.record.settlementReason ? <p className="trace-note">{event.record.settlementReason}</p> : null}
				{event.record.spans.flatMap((span) => span.links).map((link, index) => <button type="button" className="trace-related" key={index} onClick={() => go(link.traceId, link.spanId)}>{v.linked(link.traceId)}</button>)}
				{event.span.parentId ? <button type="button" className="trace-related" onClick={() => go(event.record.id, event.span.parentId)}>{v.parent(event.span.parentId)}</button> : null}
				{error ? <p className="trace-error" role="status">{error}</p> : null}
			</>}
		</div>
	</>;
}

export function TraceView({ records, selectedSpan, navigationKey, loading, hasMore, detailTab, onDetailTabChange, loadOlder, openTrace }: {
	records: readonly DevTraceRecord[]; selectedSpan: string | null; navigationKey: number; loading: boolean; hasMore: boolean;
	detailTab: TraceDetailTab; onDetailTabChange(tab: TraceDetailTab): void;
	loadOlder(): Promise<void>; openTrace(id: string, span?: string): Promise<void>;
}): React.JSX.Element {
	const { t } = useTraceLocale();
	const v = t.view;
	const turns = useMemo(() => traceTurns(records, t), [records, t]);
	const events = useMemo(() => turns.flatMap((turn) => turn.events), [turns]);
	const [selected, setSelected] = useState<string | null>(null);
	const [closedTurns, setClosedTurns] = useState<ReadonlySet<string>>(new Set());
	const [closedCalls, setClosedCalls] = useState<ReadonlySet<string>>(new Set());
	const [query, setQuery] = useState("");
	const [actual, setActual] = useState(true);
	const [range, setRange] = useState<FocusRange>(null);
	const [timelineWidth, setTimelineWidth] = useState(0);
	const [now, setNow] = useState(Date.now());
	const table = useRef<HTMLDivElement>(null);
	const [native, setNative] = useState<TraceEvent | null>(null);
	const appliedNavigation = useRef(-1);
	useEffect(() => {
		if (!records.some((record) => record.status === "running")) return;
		const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer);
	}, [records]);
	const choose = (id: string) => {
		setNative(null); setSelected(id);
		const event = events.find((row) => row.id === id);
		if (event) {
			setClosedTurns((old) => new Set([...old].filter((value) => value !== event.record.id)));
			if (event.kind === "tool") setClosedCalls((old) => new Set([...old].filter((value) => value !== event.record.id)));
		}
	};
	useEffect(() => {
		if (!selectedSpan || appliedNavigation.current === navigationKey) return;
		const event = eventForSpan(turns, selectedSpan);
		if (event) { appliedNavigation.current = navigationKey; setSelected(event.id); setNative(null); setClosedTurns(new Set()); setClosedCalls(new Set()); }
		else {
			const record = records.find((row) => row.spans.some((span) => span.id === selectedSpan));
			const span = record?.spans.find((row) => row.id === selectedSpan);
			if (record && span) { appliedNavigation.current = navigationKey; setSelected(null); setNative({ id: `${record.id}/${span.id}/native`, kind: "phase", label: t.kinds.phase, summary: span.name, record, span, step: 0, marker: false }); }
		}
	}, [selectedSpan, navigationKey, turns, records]);
	useEffect(() => {
		if (!selected) return;
		const row = [...(table.current?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])].find((element) => element.dataset.eventId === selected);
		row?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	const nativeRecord = native ? records.find((record) => record.id === native.record.id) : undefined;
	const chosen = native && nativeRecord ? { ...native, record: nativeRecord, span: nativeRecord.spans.find((span) => span.id === native.span.id) ?? native.span } : events.find((event) => event.id === selected);
	const turnNumber = chosen ? turns.findIndex((turn) => turn.id === chosen.record.id) + 1 : 0;
	const location = v.location(turnNumber, chosen?.step ?? 0);
	const toggle = (state: ReadonlySet<string>, setter: (next: ReadonlySet<string>) => void, id: string) => { const next = new Set(state); if (!next.delete(id)) next.add(id); setter(next); };
	const search = query.trim().toLocaleLowerCase();
	const matches = (event: TraceEvent) => !search || `${event.label} ${event.summary} ${event.text ?? ""} ${JSON.stringify(event.span.attributes)}`.toLocaleLowerCase().includes(search);
	const layout = useMemo(() => timelineLayout(events, actual, now, timelineWidth, records), [events, actual, now, timelineWidth, records]);
	const inRange = (event: TraceEvent) => {
		if (!range) return true;
		const block = layout.blocks.find((item) => item.event.id === event.id)!;
		return block.paintedLeft <= range.end && block.paintedLeft + block.paintedWidth >= range.start;
	};
	const ledger = <div className="trace-ledger" ref={table} aria-label={v.list}>
		<div className="trace-history"><span>{loading ? v.loading : v.history(turns.length, hasMore)}</span>{hasMore ? <button type="button" disabled={loading} onClick={() => { void loadOlder(); }}>{v.loadOlder}</button> : null}</div>
		<table className="trace-event-table"><colgroup><col className="trace-event-kind-column" /><col /></colgroup><tbody>
			{turns.map((turn, index) => {
				const visible = turn.events.filter(matches);
				if (!visible.length) return null;
				return <TurnRows key={turn.id} number={index + 1} events={visible} status={turn.record.status} collapsed={closedTurns.has(turn.id)} callsCollapsed={closedCalls.has(turn.id)} toggleTurn={() => toggle(closedTurns, setClosedTurns, turn.id)} toggleCalls={() => toggle(closedCalls, setClosedCalls, turn.id)} selected={selected} choose={choose} inRange={inRange} now={now} searching={!!search} />;
			})}
		</tbody></table>
		{!events.some(matches) ? <p className="trace-empty">{search ? v.noMatch : v.noEvents}</p> : null}
	</div>;
	return <div className="trace-trajectory">
		<div className="trace-toolbar" role="toolbar" aria-label={v.toolbar}>
			<button type="button" title={actual ? v.toEqual : v.toActual} aria-pressed={actual} onClick={() => { setActual(!actual); setRange(null); }}>{v.duration}</button>
			<button type="button" onClick={() => setClosedTurns(turns.every((turn) => closedTurns.has(turn.id)) ? new Set() : new Set(turns.map((turn) => turn.id)))}>{turns.length && turns.every((turn) => closedTurns.has(turn.id)) ? v.expandTurns : v.collapseTurns}</button>
			<button type="button" onClick={() => setClosedCalls(turns.every((turn) => closedCalls.has(turn.id)) ? new Set() : new Set(turns.map((turn) => turn.id)))}>{turns.length && turns.every((turn) => closedCalls.has(turn.id)) ? v.expandCalls : v.collapseCalls}</button>
			{range ? <button type="button" onClick={() => setRange(null)}>{v.clearRange}</button> : null}
			<input type="search" aria-label={v.search} placeholder={v.search} value={query} onChange={(event) => setQuery(event.target.value)} />
		</div>
		<TraceTimeline layout={layout} onWidthChange={setTimelineWidth} now={now} selected={selected} range={range} setRange={setRange} select={choose} />
		{chosen ? <TraceSplit label={v.resizeDetails} storageKey="loom.devTrace.ledgerFraction" defaultSize={0.5} unit="fraction" minFirst={220} minSecond={280}>
			{ledger}
			<aside className="trace-event-details" aria-label={v.details}>
				<header className="trace-details-header"><span className={`trace-kind kind-${chosen.kind}`}>{chosen.label}</span><span>{location}</span><button type="button" aria-label={v.closeDetails} onClick={() => { setSelected(null); setNative(null); }}>×</button></header>
				<EventDetails key={chosen.id} event={chosen} location={location} tab={detailTab} onTabChange={onDetailTabChange} openTrace={openTrace} />
			</aside>
		</TraceSplit> : ledger}
	</div>;
}

function TurnRows({ number, events, status, collapsed, callsCollapsed, toggleTurn, toggleCalls, selected, choose, inRange, now, searching }: {
	number: number; events: TraceEvent[]; status: string; collapsed: boolean; callsCollapsed: boolean;
	toggleTurn(): void; toggleCalls(): void; selected: string | null; choose(id: string): void; inRange(event: TraceEvent): boolean; now: number; searching: boolean;
}): React.JSX.Element {
	const { t } = useTraceLocale();
	const folded = collapsed && !searching;
	return <>
		<tr className="trace-turn-header"><td colSpan={2}><button type="button" aria-expanded={!folded} onClick={toggleTurn}>{folded ? "▸" : "▾"} {t.view.turn(number)}</button><span className={`trace-status-dot ${status}`} /><span>{traceStatus(t, status)}</span><span>{t.view.events(events.length)}</span>{events.some((event) => event.kind === "tool") ? <button type="button" aria-expanded={!callsCollapsed} onClick={toggleCalls}>{callsCollapsed ? t.view.expandCallsShort : t.view.collapseCallsShort}</button> : null}</td></tr>
		{folded ? null : events.filter((event) => searching || !callsCollapsed || event.kind !== "tool").map((event) => <tr key={event.id} className={`trace-row trace-event${selected === event.id ? " is-selected" : ""}`} tabIndex={0} aria-selected={selected === event.id} aria-label={`${event.label} · ${event.summary}`} data-event-id={event.id} data-kind={event.kind} data-focus-outside={!inRange(event) || undefined}
			onClick={() => choose(event.id)} onKeyDown={(key) => { if (key.key === "Enter" || key.key === " ") { key.preventDefault(); choose(event.id); } }}>
			<td><span className={`trace-kind kind-${event.kind}`}>{event.label}</span></td>
			<td><div className="trace-event-content"><span className="trace-event-summary" title={event.summary}>{event.summary}</span><span className="trace-event-meta">{event.kind === "assistant" ? String(event.span.attributes.model ?? "model") : ""}{event.marker ? "" : ` · ${formatTraceDuration(Math.max(0, (event.span.endedMs ?? now) - event.span.startedMs))}`}{eventStatus(event) === "error" || eventStatus(event) === "interrupted" ? ` · ${traceStatus(t, eventStatus(event))}` : ""}</span></div></td>
		</tr>)}
	</>;
}
