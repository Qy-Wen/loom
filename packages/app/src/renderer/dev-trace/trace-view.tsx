import { useEffect, useMemo, useRef, useState } from "react";
import type { DevTraceRecord } from "../../shared/dev-trace.ts";
import { TracePayload } from "./json-view.tsx";
import { TraceSplit } from "./trace-split.tsx";
import { EventPreview, SystemTools } from "./trace-preview.tsx";
import { TraceTimeline, type FocusRange } from "./trace-timeline.tsx";
import { eventForSpan, eventStatus, timelineBlocks, traceTurns, type TraceEvent } from "./trace-events.ts";
import { formatTraceDuration, spanPayload } from "./trace-spans.ts";

function EventDetails({ event, location, openTrace }: { event: TraceEvent; location: string; openTrace(id: string, span?: string): Promise<void> }): React.JSX.Element {
	const [tab, setTab] = useState<"overview" | "preview" | "raw">("preview");
	const [error, setError] = useState("");
	const [nativeOpen, setNativeOpen] = useState(false);
	const payload = event.marker ? null : spanPayload(event.span);
	const captured = event.rawContent ?? (event.text === undefined ? undefined : JSON.stringify(event.text));
	const attributes = event.span.attributes;
	const first = event.span.events.find((row) => row.name === "pi.ai.first_chunk")?.timeMs;
	const go = (id: string, span?: string) => { setError(""); void openTrace(id, span).catch(() => setError("关联轨迹已过期或不可用")); };
	return <>
		<div className="trace-detail-tabs" role="tablist" aria-label="事件详情">
			{([["overview", "概述"], ["preview", "预览"], ["raw", "原始内容"]] as const).map(([id, name]) => <button type="button" role="tab" key={id} id={`trace-event-${id}`} aria-controls="trace-event-panel" aria-selected={tab === id} onClick={() => setTab(id)}>{name}</button>)}
		</div>
		<div className="trace-io" id="trace-event-panel" role="tabpanel" aria-labelledby={`trace-event-${tab}`}>
			{event.kind === "system" ? <p className="trace-note">来自当前已加载历史中的首条模型请求记录，展示当时采集的系统提示词与工具声明；内容已脱敏、限长。</p> : null}
			{tab === "preview" ? <EventPreview event={event} /> : tab === "raw" ? <>
				<p className="trace-note">脱敏、限长后的采集内容，不是完整 HTTP 请求。</p>
				{captured !== undefined ? <section><h3>{event.kind === "system" ? "提示词正文" : "内容"}</h3><TracePayload text={captured} blobs={event.record.blobs} /></section> : null}
				{event.kind === "system" ? <SystemTools event={event} /> : null}
				{payload?.input ? <section><h3>{event.kind === "assistant" ? "Sent" : "Arguments"}</h3><TracePayload text={payload.input} blobs={event.record.blobs} /></section> : null}
				{payload?.output ? <section><h3>{event.kind === "assistant" ? "Reply" : "Result"}</h3><TracePayload text={payload.output} blobs={event.record.blobs} /></section> : null}
				<section><h3>{event.marker ? "来源调用的元数据与事件" : "元数据与事件"}</h3><TracePayload text={JSON.stringify({ ...event.span, attributes: Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith("loom.io."))) })} /></section>
				<details className="trace-native" open={nativeOpen} onToggle={(toggle) => setNativeOpen(toggle.currentTarget.open)}><summary>底层执行记录（{event.record.spans.length}）</summary>{nativeOpen ? <><p className="trace-note">这里包含本轮所有执行记录，可能含有其他消息，不仅是当前事件；内容仍经过脱敏和限长。</p><TracePayload text={JSON.stringify(event.record.spans)} blobs={event.record.blobs} /></> : null}</details>
			</> : <>
				<dl className="trace-facts">
					<dt>位置</dt><dd>{location}</dd><dt>状态</dt><dd>{eventStatus(event)}</dd>
					<dt>{event.marker ? "来源调用" : "事件"}</dt><dd>{event.span.name}</dd>
					<dt>耗时</dt><dd>{event.marker ? "无独立耗时（请求快照）" : event.span.endedMs === undefined ? "运行中" : formatTraceDuration(event.span.endedMs - event.span.startedMs)}</dd>
					{typeof first === "number" && event.kind === "assistant" ? <><dt>首 chunk</dt><dd>{formatTraceDuration(first)}</dd></> : null}
					{["provider", "model", "usage.input", "usage.output", "usage.cache_read", "usage.cache_write", "cost.total", "phase", "attempt", "outcome"].filter((key) => attributes[key] !== undefined).map((key) => <div className="trace-fact" key={key}><dt>{key}</dt><dd>{String(attributes[key])}</dd></div>)}
					<dt>Trace ID</dt><dd>{event.record.id}</dd><dt>Span ID</dt><dd>{event.span.id}</dd>
				</dl>
				{event.span.status.status === "error" ? <p className="trace-error">{event.span.status.error?.message ?? "执行失败"}</p> : null}
				{event.record.settlementReason ? <p className="trace-note">{event.record.settlementReason}</p> : null}
				{event.record.spans.flatMap((span) => span.links).map((link, index) => <button type="button" className="trace-related" key={index} onClick={() => go(link.traceId, link.spanId)}>关联调用 → {link.traceId}</button>)}
				{event.span.parentId ? <button type="button" className="trace-related" onClick={() => go(event.record.id, event.span.parentId)}>父调用 → {event.span.parentId}</button> : null}
				{error ? <p className="trace-error" role="status">{error}</p> : null}
			</>}
		</div>
	</>;
}

export function TraceView({ records, selectedSpan, navigationKey, loading, hasMore, loadOlder, openTrace }: {
	records: readonly DevTraceRecord[]; selectedSpan: string | null; navigationKey: number; loading: boolean; hasMore: boolean;
	loadOlder(): Promise<void>; openTrace(id: string, span?: string): Promise<void>;
}): React.JSX.Element {
	const turns = useMemo(() => traceTurns(records), [records]);
	const events = useMemo(() => turns.flatMap((turn) => turn.events), [turns]);
	const [selected, setSelected] = useState<string | null>(null);
	const [closedTurns, setClosedTurns] = useState<ReadonlySet<string>>(new Set());
	const [closedCalls, setClosedCalls] = useState<ReadonlySet<string>>(new Set());
	const [query, setQuery] = useState("");
	const [actual, setActual] = useState(false);
	const [range, setRange] = useState<FocusRange>(null);
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
			if (record && span) { appliedNavigation.current = navigationKey; setSelected(null); setNative({ id: `${record.id}/${span.id}/native`, kind: "phase", label: "底层记录", summary: span.name, record, span, step: 0, marker: false }); }
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
	const location = `第 ${turnNumber} 轮${chosen?.step ? ` · 第 ${chosen.step} 步` : ""}`;
	const toggle = (state: ReadonlySet<string>, setter: (next: ReadonlySet<string>) => void, id: string) => { const next = new Set(state); if (!next.delete(id)) next.add(id); setter(next); };
	const search = query.trim().toLocaleLowerCase();
	const matches = (event: TraceEvent) => !search || `${event.label} ${event.summary} ${event.text ?? ""} ${JSON.stringify(event.span.attributes)}`.toLocaleLowerCase().includes(search);
	const blocks = timelineBlocks(events, actual, now);
	const inRange = (event: TraceEvent) => {
		if (!range) return true;
		const block = blocks.find((item) => item.event.id === event.id)!;
		return block.left <= range.end && block.left + block.width >= range.start;
	};
	const ledger = <div className="trace-ledger" ref={table} aria-label="轨迹事件列表">
		<div className="trace-history"><span>{loading ? "加载中…" : `${turns.length} 条已加载轨迹${hasMore ? " · 更早历史未加载" : " · 保留期内历史"}`}</span>{hasMore ? <button type="button" disabled={loading} onClick={() => { void loadOlder(); }}>加载更早轮次</button> : null}</div>
		<table className="trace-event-table"><colgroup><col className="trace-event-kind-column" /><col /></colgroup><tbody>
			{turns.map((turn, index) => {
				const visible = turn.events.filter(matches);
				if (!visible.length) return null;
				return <TurnRows key={turn.id} number={index + 1} events={visible} status={turn.record.status} collapsed={closedTurns.has(turn.id)} callsCollapsed={closedCalls.has(turn.id)} toggleTurn={() => toggle(closedTurns, setClosedTurns, turn.id)} toggleCalls={() => toggle(closedCalls, setClosedCalls, turn.id)} selected={selected} choose={choose} inRange={inRange} now={now} searching={!!search} />;
			})}
		</tbody></table>
		{!events.some(matches) ? <p className="trace-empty">{search ? "没有匹配事件" : "暂无执行事件"}</p> : null}
	</div>;
	return <div className="trace-trajectory">
		<div className="trace-toolbar" role="toolbar" aria-label="轨迹工具栏">
			<button type="button" title={actual ? "切换为事件等宽" : "切换为真实时长，保留并行与空闲时间"} aria-pressed={actual} onClick={() => { setActual(!actual); setRange(null); }}>◷ 时长</button>
			<button type="button" onClick={() => setClosedTurns(turns.every((turn) => closedTurns.has(turn.id)) ? new Set() : new Set(turns.map((turn) => turn.id)))}>{turns.length && turns.every((turn) => closedTurns.has(turn.id)) ? "⊞ 展开轮次" : "⊟ 收起轮次"}</button>
			<button type="button" onClick={() => setClosedCalls(turns.every((turn) => closedCalls.has(turn.id)) ? new Set() : new Set(turns.map((turn) => turn.id)))}>{turns.length && turns.every((turn) => closedCalls.has(turn.id)) ? "⊞ 展开调用" : "⊟ 收起调用"}</button>
			{range ? <button type="button" onClick={() => setRange(null)}>清除范围</button> : null}
			<input type="search" aria-label="搜索轨迹" placeholder="搜索轨迹" value={query} onChange={(event) => setQuery(event.target.value)} />
		</div>
		<TraceTimeline events={events} actual={actual} now={now} selected={selected} range={range} setRange={setRange} select={choose} />
		{chosen ? <TraceSplit label="调整事件详情宽度" storageKey="loom.devTrace.ledgerFraction" defaultSize={0.5} unit="fraction" minFirst={220} minSecond={280}>
			{ledger}
			<aside className="trace-event-details" aria-label="事件详情">
				<header className="trace-details-header"><span className={`trace-kind kind-${chosen.kind}`}>{chosen.label}</span><span>{location}</span><button type="button" aria-label="关闭详情" onClick={() => { setSelected(null); setNative(null); }}>×</button></header>
				<EventDetails key={chosen.id} event={chosen} location={location} openTrace={openTrace} />
			</aside>
		</TraceSplit> : ledger}
	</div>;
}

function TurnRows({ number, events, status, collapsed, callsCollapsed, toggleTurn, toggleCalls, selected, choose, inRange, now, searching }: {
	number: number; events: TraceEvent[]; status: string; collapsed: boolean; callsCollapsed: boolean;
	toggleTurn(): void; toggleCalls(): void; selected: string | null; choose(id: string): void; inRange(event: TraceEvent): boolean; now: number; searching: boolean;
}): React.JSX.Element {
	const folded = collapsed && !searching;
	return <>
		<tr className="trace-turn-header"><td colSpan={2}><button type="button" aria-expanded={!folded} onClick={toggleTurn}>{folded ? "▸" : "▾"} 第 {number} 轮</button><span className={`trace-status-dot ${status}`} /><span>{status}</span><span>{events.length} 个事件</span>{events.some((event) => event.kind === "tool") ? <button type="button" aria-expanded={!callsCollapsed} onClick={toggleCalls}>{callsCollapsed ? "展开调用" : "收起调用"}</button> : null}</td></tr>
		{folded ? null : events.filter((event) => searching || !callsCollapsed || event.kind !== "tool").map((event) => <tr key={event.id} className={`trace-row trace-event${selected === event.id ? " is-selected" : ""}`} tabIndex={0} aria-selected={selected === event.id} aria-label={`${event.label} · ${event.summary}`} data-event-id={event.id} data-kind={event.kind} data-focus-outside={!inRange(event) || undefined}
			onClick={() => choose(event.id)} onKeyDown={(key) => { if (key.key === "Enter" || key.key === " ") { key.preventDefault(); choose(event.id); } }}>
			<td><span className={`trace-kind kind-${event.kind}`}>{event.label}</span></td>
			<td><div className="trace-event-content"><span className="trace-event-summary" title={event.summary}>{event.summary}</span><span className="trace-event-meta">{event.kind === "assistant" ? String(event.span.attributes.model ?? "model") : ""}{event.marker ? "" : ` · ${formatTraceDuration(Math.max(0, (event.span.endedMs ?? now) - event.span.startedMs))}`}{eventStatus(event) === "error" || eventStatus(event) === "interrupted" ? ` · ${eventStatus(event)}` : ""}</span></div></td>
		</tr>)}
	</>;
}
