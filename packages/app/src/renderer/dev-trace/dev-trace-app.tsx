import { useEffect, useRef, useState } from "react";
import type { DevTraceRecord } from "../../shared/dev-trace.ts";
import { traceSummary } from "./trace-spans.ts";
import { TraceTree } from "./trace-view.tsx";

function formatTime(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function DevTraceApp(): React.JSX.Element {
	const [records, setRecords] = useState<DevTraceRecord[]>([]);
	const [selected, setSelected] = useState<string | null>(null);
	const followLatest = useRef(true);
	const sourceRevision = useRef(0);
	const [hasMore, setHasMore] = useState(false);
	const merge = (record: DevTraceRecord) => setRecords((prev) => {
		const existing = prev.find((row) => row.id === record.id);
		if (existing && existing.revision >= record.revision) return prev;
		return [...prev.filter((row) => row.id !== record.id), record].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
	});

	useEffect(() => {
		let alive = true;
		let received = 0;
		const add = (record: DevTraceRecord | null) => {
			if (!alive) return;
			if (!record) { sourceRevision.current++; received = 0; setRecords([]); setSelected(null); setHasMore(false); followLatest.current = true; return; }
			if (++received === 40) setHasMore(true);
			merge(record);
			setSelected((current) => (followLatest.current || current === null ? record.id : current));
		};
		const stop = window.loomDev.onTrace(add);
		const revision = sourceRevision.current;
		void window.loomDev.getTraces().then((list) => {
			if (!alive || sourceRevision.current !== revision) return;
			setHasMore(list.length === 40);
			for (const record of list.reverse()) add(record);
		});
		return () => {
			alive = false;
			stop();
		};
	}, []);

	const current = records.find((record) => record.id === selected) ?? null;
	const latestId = records.at(-1)?.id;

	return (
		<div className="trace-app">
			<aside className="trace-list">
				{records.length === 0 ? <p className="trace-empty">No traces yet.</p> : null}
				{records.slice().reverse().map((record) => (
					<button
						key={record.id}
						type="button"
						className={record.id === selected ? "trace-item is-selected" : "trace-item"}
						onClick={() => {
							followLatest.current = record.id === latestId;
							setSelected(record.id);
						}}
					>
						<span className="trace-item-time">{formatTime(record.at)}</span>
						<span className="trace-item-summary">{record.status} · {traceSummary(record.spans) || "empty"}</span>
					</button>
				))}
				{hasMore ? <button type="button" onClick={() => {
					const oldest = records[0]; if (!oldest) return;
					const revision = sourceRevision.current;
					void window.loomDev.getTraces({ at: oldest.at, id: oldest.id }).then((list) => {
						if (sourceRevision.current !== revision) return;
						setHasMore(list.length === 40); for (const record of list) merge(record);
					});
				}}>Load older traces</button> : null}
			</aside>
			<main className="trace-detail">
				{current && traceSummary(current.spans) ? <TraceTree key={current.id} spans={current.spans} /> : null}
				{current && !traceSummary(current.spans) ? <p className="trace-empty">No spans.</p> : null}
			</main>
		</div>
	);
}
