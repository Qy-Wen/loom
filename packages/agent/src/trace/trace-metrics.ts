import type { LoomTraceMetric } from "./trace-types.ts";

/** Keep examples bounded independently of the number of measurements in an interval. */
export const MAX_METRIC_EXEMPLARS = 8;

export function metricSeries(metric: LoomTraceMetric): string {
	const attributes = Object.fromEntries(Object.entries(metric.attributes).sort(([a], [b]) => a.localeCompare(b)));
	const series: unknown[] = [metric.name, metric.kind, metric.unit, attributes];
	// Preserve the key of pre-metadata rows so they can still merge without a database migration.
	if (metric.description !== undefined || metric.boundaries !== undefined) series.push(metric.description, metric.boundaries);
	return JSON.stringify(series);
}

/** Merge only identical series and intervals; bucket counts are non-cumulative, including the final +Inf bucket. */
export function mergeMetric(previous: LoomTraceMetric | undefined, metric: LoomTraceMetric): LoomTraceMetric {
	if (!previous) return metric;
	return {
		...metric,
		count: previous.count + metric.count,
		sum: previous.sum + metric.sum,
		min: Math.min(previous.min, metric.min),
		max: Math.max(previous.max, metric.max),
		...(metric.bucketCounts ? { bucketCounts: metric.bucketCounts.map((count, index) => count + (previous.bucketCounts?.[index] ?? 0)) } : {}),
		...((previous.exemplars?.length || metric.exemplars?.length) ? { exemplars: [...previous.exemplars ?? [], ...metric.exemplars ?? []].slice(-MAX_METRIC_EXEMPLARS) } : {}),
	};
}
