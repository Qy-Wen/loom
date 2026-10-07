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

	useEffect(() => {
		let alive = true;
		const seen = new Set<string>();
		const add = (record: DevTraceRecord) => {
			if (!alive || seen.has(record.id)) return;
			seen.add(record.id);
			setRecords((prev) => [...prev, record].slice(-40));
			setSelected((current) => (followLatest.current || current === null ? record.id : current));
		};
		const stop = window.loomDev.onTrace(add);
		void window.loomDev.getTraces().then((list) => {
			if (!alive) return;
			for (const record of list) add(record);
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
						<span className="trace-item-summary">{traceSummary(record.spans) || "empty"}</span>
					</button>
				))}
			</aside>
			<main className="trace-detail">
				{current && traceSummary(current.spans) ? <TraceTree key={current.id} spans={current.spans} /> : null}
				{current && !traceSummary(current.spans) ? <p className="trace-empty">No spans.</p> : null}
			</main>
		</div>
	);
}
