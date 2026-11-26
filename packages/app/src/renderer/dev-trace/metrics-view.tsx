import { useEffect, useRef, useState } from "react";
import type { DevTraceMetric } from "../../shared/dev-trace.ts";
import { useTraceLocale } from "./trace-locale.tsx";
import { formatMetricValue, metricBuckets, metricRowKey } from "./trace-metrics.ts";

type Exemplar = NonNullable<DevTraceMetric["exemplars"]>[number];

export function MetricsView({ openTrace }: { openTrace: (example: Exemplar) => Promise<void> }): React.JSX.Element {
	const { t } = useTraceLocale();
	const tm = t.metrics;
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
				if (active) setError(tm.unavailable);
			} finally {
				if (active) timer = setTimeout(() => { void refresh(); }, 1000);
			}
		};
		void refresh();
		return () => { active = false; alive.current = false; clearTimeout(timer); };
	}, []);

	return (
		<div className="trace-metrics" role="tabpanel" id="metrics-panel" aria-labelledby="metrics-tab">
			<p className="trace-empty">{tm.note}</p>
			{error || navigationError ? <p className="trace-metrics-error" role="status">{error || navigationError}</p> : null}
			{metrics === null ? <p className="trace-empty">{tm.loading}</p> : metrics.length === 0 ? <p className="trace-empty">{tm.empty}</p> : (
				<table>
					<thead><tr><th>{tm.columns.interval}</th><th>{tm.columns.metric}</th><th>{tm.columns.count}</th><th>{tm.columns.sum}</th><th>{tm.columns.mean}</th><th>{tm.columns.min}</th><th>{tm.columns.max}</th></tr></thead>
					<tbody>{metrics.map((metric) => {
						const buckets = metricBuckets(metric);
						const exemplars = metric.exemplars ?? [];
						return (
							<tr key={metricRowKey(metric)}>
								<td>{new Date(metric.intervalMs).toLocaleString()}</td>
								<td>
									<div className="trace-metric-title">
										<strong>{metric.name}</strong>
										{metric.unit ? <span className="trace-metric-kind">({metric.unit})</span> : null}
									</div>
									{metric.description ? <p className="trace-metric-description">{metric.description}</p> : null}
									<code>{JSON.stringify(metric.attributes)}</code>
									{buckets.length > 0 || exemplars.length > 0 ? (
										<div className="trace-metric-extra">
											{buckets.map((bucket) => <div key={bucket.label}><code>{bucket.label}</code>: {bucket.count}</div>)}
											{exemplars.map((example, i) => (
												<button type="button" key={i} data-tooltip={`${example.traceId} / ${example.spanId}`} onClick={() => {
													setNavigationError("");
													void openTrace(example).catch(() => { if (alive.current) setNavigationError(t.referenceUnavailable); });
												}}>{tm.exemplar(new Date(example.at).toLocaleTimeString(), formatMetricValue(example.value))}</button>
											))}
										</div>
									) : null}
								</td>
								<td>{formatMetricValue(metric.count)}</td>
								<td>{formatMetricValue(metric.sum)}</td>
								<td>{metric.kind === "histogram" && metric.count > 0 ? formatMetricValue(metric.sum / metric.count) : "—"}</td>
								<td>{formatMetricValue(metric.min)}</td>
								<td>{formatMetricValue(metric.max)}</td>
							</tr>
						);
					})}</tbody>
				</table>
			)}
		</div>
	);
}
