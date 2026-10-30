import { useCallback, useEffect, useRef, useState } from "react";
import type { DevTraceConversation, DevTraceRecord, TraceCursor } from "../../shared/dev-trace.ts";
import { MetricsView } from "./metrics-view.tsx";
import { TraceSplit } from "./trace-split.tsx";
import { TraceView, type TraceDetailTab } from "./trace-view.tsx";
import { conversationId } from "./trace-events.ts";
import { useTraceLocale } from "./trace-locale.tsx";
import { traceStatus } from "./trace-messages.ts";

type ConversationRow = DevTraceConversation & { partial?: boolean };
const order = (a: { at: number; id: string }, b: { at: number; id: string }) => b.at - a.at || b.id.localeCompare(a.id);
const mergeRecords = (old: DevTraceRecord[], rows: readonly DevTraceRecord[]) => {
	const map = new Map(old.map((row) => [row.id, row]));
	for (const row of rows) if ((map.get(row.id)?.revision ?? -1) < row.revision) map.set(row.id, row);
	return [...map.values()].sort(order);
};

export function DevTraceApp(): React.JSX.Element {
	const { t } = useTraceLocale();
	const tr = useRef(t); tr.current = t;
	const [conversations, setConversations] = useState<ConversationRow[]>([]);
	const [records, setRecords] = useState<DevTraceRecord[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const [selectedSpan, setSelectedSpan] = useState<string | null>(null);
	const [navigationKey, setNavigationKey] = useState(0);
	const listVersion = useRef(0);
	const [tab, setTab] = useState<"traces" | "metrics">("traces");
	// A viewer preference, independent of event/conversation remounts and content folds.
	const [detailTab, setDetailTab] = useState<TraceDetailTab>("preview");
	const [sourceKey, setSourceKey] = useState(0);
	const sourceRevision = useRef(0);
	const [moreConversations, setMoreConversations] = useState(false);
	const pagedConversations = useRef(false);
	const conversationCursor = useRef<TraceCursor | null>(null);
	const [moreHistory, setMoreHistory] = useState<Record<string, boolean>>({});
	const historyCursor = useRef<Record<string, TraceCursor | null>>({});
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const alive = useRef(true);

	const loadConversations = useCallback(async (before?: TraceCursor) => {
		const revision = sourceRevision.current, version = listVersion.current;
		try {
			const rows = await window.loomDev.getConversations(before);
			if (!alive.current || revision !== sourceRevision.current || version !== listVersion.current) return;
			setConversations((old) => {
				const map = new Map(old.map((row) => [row.id, row]));
				for (const row of rows) map.set(row.id, { ...row, partial: false });
				return [...map.values()].sort(order);
			});
			if (before) pagedConversations.current = true;
			if (before || !pagedConversations.current) {
				setMoreConversations(rows.length === 40);
				const oldest = rows.at(-1); conversationCursor.current = oldest ? { at: oldest.at, id: oldest.id } : null;
			}
			setSelected((old) => old ?? rows[0]?.id ?? null);
		} catch { if (alive.current && revision === sourceRevision.current) setError(tr.current.app.listError); }
	}, []);
	const refresh = useRef(loadConversations); refresh.current = loadConversations;

	useEffect(() => {
		alive.current = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = window.loomDev.onTrace((record) => {
			listVersion.current++;
			if (!record) {
				sourceRevision.current++; setSourceKey(sourceRevision.current); pagedConversations.current = false; historyCursor.current = {}; conversationCursor.current = null;
				setConversations([]); setRecords([]); setSelected(null); setSelectedSpan(null); setMoreHistory({}); setMoreConversations(false); setError(""); setLoading(false);
				clearTimeout(timer); timer = setTimeout(() => { timer = undefined; void refresh.current(); }, 100);
				return;
			}
			setRecords((old) => mergeRecords(old, [record]));
			const id = conversationId(record);
			setConversations((old) => {
				const previous = old.find((row) => row.id === id);
				return [...old.filter((row) => row.id !== id), { ...previous, id, at: Math.max(previous?.at ?? 0, record.at), count: previous?.count ?? 1, partial: previous?.partial ?? true, status: record.status }].sort(order);
			});
			setSelected((old) => old ?? id);
			if (!timer) timer = setTimeout(() => { timer = undefined; void refresh.current(); }, 200);
		});
		void refresh.current();
		return () => { alive.current = false; stop(); clearTimeout(timer); };
	}, []);

	useEffect(() => {
		if (!selected) return;
		if (Object.hasOwn(historyCursor.current, selected)) { setLoading(false); return; }
		let active = true;
		const revision = sourceRevision.current;
		setLoading(true); setError("");
		void window.loomDev.getConversation(selected).then((rows) => {
			if (!active || revision !== sourceRevision.current) return;
			setRecords((old) => mergeRecords(old, rows));
			setMoreHistory((old) => ({ ...old, [selected]: rows.length === 40 }));
			const oldest = rows.at(-1);
			historyCursor.current[selected] = oldest ? { at: oldest.at, id: oldest.id } : null;
		}).catch(() => { if (active && revision === sourceRevision.current) setError(tr.current.app.historyError); })
			.finally(() => { if (active && revision === sourceRevision.current) setLoading(false); });
		return () => { active = false; };
	}, [selected, sourceKey]);

	const selectedRef = useRef(selected); selectedRef.current = selected;
	const current = records.filter((record) => conversationId(record) === selected);
	const loadOlder = async () => {
		if (!selected) return;
		// Exemplar navigation may add a much older record. Page from the actual history boundary, not that record.
		const before = historyCursor.current[selected]; if (!before) return;
		const revision = sourceRevision.current, id = selected;
		setLoading(true);
		try {
			const rows = await window.loomDev.getConversation(id, before);
			if (!alive.current || revision !== sourceRevision.current) return;
			setRecords((old) => mergeRecords(old, rows)); setMoreHistory((old) => ({ ...old, [id]: rows.length === 40 }));
			const oldest = rows.at(-1); historyCursor.current[id] = oldest ? { at: oldest.at, id: oldest.id } : null;
		} catch { if (alive.current && revision === sourceRevision.current && selectedRef.current === id) setError(tr.current.app.olderError); }
		finally { if (alive.current && revision === sourceRevision.current && selectedRef.current === id) setLoading(false); }
	};
	const openTrace = async (traceId: string, spanId?: string) => {
		const revision = sourceRevision.current;
		const record = await window.loomDev.getTrace(traceId);
		if (!alive.current || revision !== sourceRevision.current) return;
		if (!record) throw new Error("Referenced trace is unavailable or expired.");
		setRecords((old) => mergeRecords(old, [record]));
		const id = conversationId(record);
		setConversations((old) => old.some((row) => row.id === id) ? old : [...old, { id, at: record.at, count: 1, status: record.status, partial: true }].sort(order));
		setSelected(id); setSelectedSpan(spanId ?? record.spans[0]?.id ?? null); setNavigationKey((old) => old + 1); setTab("traces");
		void refresh.current();
	};

	return <div className="trace-shell">
		<nav className="trace-tabs" role="tablist" aria-label={t.tabs.label}>
			<button role="tab" id="traces-tab" aria-controls="traces-panel" aria-selected={tab === "traces"} onClick={() => setTab("traces")}>{t.tabs.traces}</button>
			<button role="tab" id="metrics-tab" aria-controls="metrics-panel" aria-selected={tab === "metrics"} onClick={() => setTab("metrics")}>{t.tabs.metrics}</button>
		</nav>
		{tab === "metrics" ? <MetricsView key={sourceKey} openTrace={(example) => openTrace(example.traceId, example.spanId)} /> : null}
		<div className="trace-app" hidden={tab !== "traces"} role="tabpanel" id="traces-panel" aria-labelledby="traces-tab">
			<TraceSplit label={t.app.resizeList} storageKey="loom.devTrace.listWidth" defaultSize={220} minFirst={150} minSecond={440}>
				<aside className="trace-list" aria-label={t.app.listLabel}>
					<div className="trace-list-heading">{t.app.listHeading} <span>{conversations.length}</span></div>
					{conversations.length === 0 ? <p className="trace-empty">{t.app.empty}</p> : null}
					{conversations.map((row) => <button type="button" key={row.id} className={`trace-item${row.id === selected ? " is-selected" : ""}`} aria-pressed={row.id === selected} onClick={() => { setSelected(row.id); setSelectedSpan(null); }}>
						<span className="trace-item-title">{row.title || (row.id.startsWith("trace:") ? t.app.orphan : t.app.conversation(row.id))}</span>
						<span className="trace-item-summary"><span className={`trace-status-dot ${row.status}`} />{traceStatus(t, row.status)} · {row.partial ? t.app.loaded(records.filter((record) => conversationId(record) === row.id).length) : t.app.traces(row.count)}</span>
						<span className="trace-item-time">{new Date(row.at).toLocaleString()}</span>
					</button>)}
					{moreConversations ? <button className="trace-load" type="button" onClick={() => { if (conversationCursor.current) void loadConversations(conversationCursor.current); }}>{t.app.loadEarlier}</button> : null}
				</aside>
				<main className="trace-detail">
					{error ? <p className="trace-error" role="status">{error}</p> : null}
					{selected ? <TraceView key={`${sourceKey}:${selected}`} records={current} selectedSpan={selectedSpan} navigationKey={navigationKey} loading={loading} hasMore={moreHistory[selected] ?? false} detailTab={detailTab} onDetailTabChange={setDetailTab} loadOlder={loadOlder} openTrace={openTrace} /> : <p className="trace-empty">{t.app.select}</p>}
				</main>
			</TraceSplit>
		</div>
	</div>;
}
