import assert from "node:assert/strict";
import { test } from "node:test";
import type { LoomTraceMetric } from "@loom/agent";
import { formatMetricValue, metricBuckets, metricRowKey } from "../src/renderer/dev-trace/trace-metrics.ts";

const metric: LoomTraceMetric = {
	name: "latency", kind: "histogram", unit: "ms", attributes: {}, intervalMs: 10_000,
	count: 4, sum: 18, min: -1, max: 12, boundaries: [0, 5, 10], bucketCounts: [1, 1, 1, 1],
};

test("metric bucket labels preserve inclusive boundaries and the overflow bucket", () => {
	assert.deepEqual(metricBuckets(metric), [
		{ label: "(−∞, 0]", count: 1 }, { label: "(0, 5]", count: 1 },
		{ label: "(5, 10]", count: 1 }, { label: "(10, +∞)", count: 1 },
	]);
	assert.deepEqual(metricBuckets({ ...metric, boundaries: [], bucketCounts: [4] }), [{ label: "(−∞, +∞)", count: 4 }]);
	assert.deepEqual(metricBuckets({ ...metric, boundaries: undefined, bucketCounts: undefined }), []);
});

test("metric display preserves small costs and signed deltas", () => {
	assert.notEqual(formatMetricValue(0.0000001), formatMetricValue(0));
	assert.match(formatMetricValue(-1), /1/);
});

test("metric row keys retain open details through updates and distinguish series", () => {
	const row = { ...metric, attributes: { a: "one", b: "two" } };
	assert.equal(metricRowKey(row), metricRowKey({ ...row, count: 9, sum: 42, attributes: { b: "two", a: "one" } }));
	for (const changed of [{ intervalMs: 20_000 }, { description: "other" }, { boundaries: [5, 10] }, { unit: "s" }, { attributes: { a: "other" } }]) {
		assert.notEqual(metricRowKey(row), metricRowKey({ ...row, ...changed }));
	}
});
