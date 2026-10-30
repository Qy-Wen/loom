import { useEffect, useRef, useState } from "react";
import type { DevTraceMetric } from "../../shared/dev-trace.ts";
import { formatMetricValue, metricBuckets, metricRowKey } from "./trace-metrics.ts";

type Exemplar = NonNullable<DevTraceMetric["exemplars"]>[number];

export function MetricsView({ openTrace }: { openTrace: (example: Exemplar) => Promise<void> }): React.JSX.Element {
	const [metrics, setMetrics] = useState<DevTraceMetric[] | null>(null);
	const [error, setError] = useState("");
	const [navigationError, setNavigationError] = useState("");
	const alive = useRef(true);

	useEffect(() => {
		alive.current = true;
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				const rows = await window.loomDev.getMetrics();
				if (active) { setMetrics(rows); setError(""); }
			} catch {
				if (active) setError("Metrics unavailable.");
			} finally {
				if (active) timer = setTimeout(() => { void refresh(); }, 1000);
			}
		};
		void refresh();
		return () => { active = false; alive.current = false; clearTimeout(timer); };
	}, []);

	return (
		<div className="trace-metrics" role="tabpanel" id="metrics-panel" aria-labelledby="metrics-tab">
			<p className="trace-empty">Latest 200 metric rows · ten-second intervals · current library · refreshes every second. Active-task values are deltas, not a current-task total.</p>
			{error || navigationError ? <p className="trace-metrics-error" role="status">{error || navigationError}</p> : null}
			{metrics === null ? <p className="trace-empty">Loading metrics…</p> : metrics.length === 0 ? <p className="trace-empty">No metrics yet.</p> : (
				<table>
					<thead><tr><th>Interval</th><th>Metric</th><th>Count</th><th>Sum</th><th>Mean</th><th>Min</th><th>Max</th></tr></thead>
					<tbody>{metrics.map((metric) => (
						<tr key={metricRowKey(metric)}>
							<td>{new Date(metric.intervalMs).toLocaleString()}</td>
							<td>
								<strong>{metric.name}</strong>
								<div className="trace-metric-kind">{metric.kind}{metric.unit ? ` · ${metric.unit}` : ""}</div>
								<code>{JSON.stringify(metric.attributes)}</code>
								<details>
									<summary>Metadata, buckets and exemplars</summary>
									{metric.description ? <p>{metric.description}</p> : null}
									{metricBuckets(metric).map((bucket) => <div key={bucket.label}><code>{bucket.label}</code>: {bucket.count}</div>)}
									{metric.exemplars?.map((example, i) => (
										<button type="button" key={i} title={`${example.traceId} / ${example.spanId}`} onClick={() => {
											setNavigationError("");
											void openTrace(example).catch(() => { if (alive.current) setNavigationError("Referenced trace is unavailable or expired."); });
										}}>Trace · {new Date(example.at).toLocaleTimeString()} · {formatMetricValue(example.value)}</button>
									))}
								</details>
							</td>
							<td>{formatMetricValue(metric.count)}</td>
							<td>{formatMetricValue(metric.sum)}</td>
							<td>{metric.kind === "histogram" && metric.count > 0 ? formatMetricValue(metric.sum / metric.count) : "—"}</td>
							<td>{formatMetricValue(metric.min)}</td>
							<td>{formatMetricValue(metric.max)}</td>
						</tr>
					))}</tbody>
				</table>
			)}
		</div>
	);
}
