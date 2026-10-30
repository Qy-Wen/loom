import type { DevTraceMetric } from "../../shared/dev-trace.ts";

export function formatMetricValue(value: number): string {
	return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

export function metricRowKey(metric: DevTraceMetric): string {
	const attributes = Object.entries(metric.attributes).sort(([a], [b]) => a.localeCompare(b));
	return JSON.stringify([metric.intervalMs, metric.name, metric.kind, metric.unit, metric.description, metric.boundaries, attributes]);
}

/** Each bucket is exclusive of the previous boundary and inclusive of its own. */
export function metricBuckets(metric: DevTraceMetric): { label: string; count: number }[] {
	const { boundaries, bucketCounts } = metric;
	if (!boundaries || !bucketCounts) return [];
	return bucketCounts.map((count, index) => {
		const lower = index === 0 ? "−∞" : formatMetricValue(boundaries[index - 1]!);
		const upper = index === boundaries.length ? "+∞)" : `${formatMetricValue(boundaries[index]!)}]`;
		return { label: `(${lower}, ${upper}`, count };
	});
}
