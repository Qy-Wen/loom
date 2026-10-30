import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { NOOP_TELEMETRY_CONTEXT, type RecordedTelemetryMeasurement } from "@earendil-works/pi-telemetry";
import { MAX_METRIC_EXEMPLARS } from "../src/trace/trace-metrics.ts";
import { TraceStore, TRACE_RETENTION_MS } from "../src/trace/trace-store.ts";
import { LiveTelemetry } from "../src/trace/trace-recorder.ts";
import { TracePrivacy } from "../src/trace/trace-privacy.ts";

for (const probe of createTelemetryAdapterConformance(async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-telemetry-contract-"));
	const store = await TraceStore.open(root);
	const measurements: RecordedTelemetryMeasurement[] = [];
	const recorder = new LiveTelemetry(store, new TracePrivacy(), { onMeasurement: (measurement) => measurements.push(measurement) });
	return {
		context: recorder, propagation: recorder.propagation, metrics: recorder.metrics,
		getMetrics: async () => structuredClone(measurements),
		getSpans: async () => {
			recorder.flush();
			const spans = store.list(200).flatMap((record) => record.spans).sort((a, b) => a.startedMs - b.startedMs);
			const localId = (id: string) => Number(id.split(":").at(-1));
			const ended = spans.filter((span) => span.endedMs !== undefined).sort((a, b) => a.endedMs! - b.endedMs!);
			return spans.map((span) => ({
				id: localId(span.id), parentId: span.parentId && spans.some((row) => row.id === span.parentId) ? localId(span.parentId) : null,
				context: { "loom.trace": span.traceId, "loom.span": span.id },
				parentContext: span.parentId ? { "loom.trace": span.traceId, "loom.span": span.parentId } : null,
				links: span.links.map((link) => ({ context: { "loom.trace": link.traceId, "loom.span": link.spanId }, attributes: link.attributes ?? {} })),
				name: span.name, attributes: span.attributes, events: span.events.map(({ name, attributes }) => ({ name, attributes })), status: span.status,
				settled: span.endedMs !== undefined, ...(span.endedMs === undefined ? {} : { endSequence: ended.findIndex((row) => row.id === span.id) + 1 }),
			}));
		},
		[Symbol.asyncDispose]: async () => { recorder.stop(); await rm(root, { recursive: true, force: true }); },
	};
})) test(`native telemetry contract: ${probe.group}: ${probe.name}`, probe.run);

test("retention deletes trace payloads and metrics after 30 days and ignores legacy history", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "loom-telemetry-retention-"));
	const store = await TraceStore.open(root);
	const legacy = join(root, ".loom", "agents", "traces", "traces.sqlite");
	await writeFile(legacy, "legacy-file-kept");
	const now = Date.now(); let clock = now;
	t.mock.method(Date, "now", () => clock);
	try {
		store.save({ id: "old", at: now, threadId: "1", revision: 1, status: "completed", spans: [], blobs: { text: "expired payload" } });
		store.measure({ intervalMs: now, name: "tokens", kind: "counter", attributes: {}, count: 1, sum: 3, min: 3, max: 3 });
		clock = now + TRACE_RETENTION_MS - 1;
		assert.ok(store.get("old")); assert.equal(store.metrics("tokens").length, 1);
		clock += 2;
		assert.equal(store.get("old"), undefined); assert.equal(store.list().length, 0); assert.equal(store.metrics("tokens").length, 0); assert.equal(store.listMetrics().length, 0);
		store.prune();
		const db = new DatabaseSync(store.path);
		try { assert.equal(db.prepare("SELECT count(*) AS n FROM traces").get()!.n, 0); assert.equal(db.prepare("SELECT count(*) AS n FROM metrics").get()!.n, 0); }
		finally { db.close(); }
		assert.equal(await readFile(legacy, "utf8"), "legacy-file-kept");
	} finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("native metrics aggregate and diagnostic storage failure preserves callback results", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-telemetry-failure-"));
	const store = await TraceStore.open(root);
	let failures = 0;
	const recorder = new LiveTelemetry(store, new TracePrivacy(), { publish: () => { throw new Error("publisher"); }, report: () => { failures++; } });
	try {
		recorder.metrics.counter("tokens").add(2, { model: "demo" });
		recorder.metrics.counter("tokens").add(3, { model: "demo" });
		recorder.flush();
		assert.equal(store.metrics("tokens")[0]!.sum, 5);
		const result = {};
		store.save = () => { throw new Error("disk unavailable"); };
		assert.equal(await recorder.startSpan({ name: "request" }, (span) => { span.addEvent("event"); return result; }), result);
		assert.equal(failures, 1);
		const error = new Error("original");
		await assert.rejects(recorder.startSpan({ name: "next" }, () => { throw error; }), (actual) => actual === error);
		assert.equal(failures, 1);
	} finally { recorder.stop(); await rm(root, { recursive: true, force: true }); }
});

test("histogram metadata, buckets, and bounded exemplars survive flush and reopen", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "loom-metric-buckets-"));
	let store = await TraceStore.open(root);
	const at = Date.now();
	t.mock.method(Date, "now", () => at);
	const recorder = new LiveTelemetry(store, new TracePrivacy());
	try {
		const options = { description: "Latency", unit: "ms", boundaries: [0, 5, 10] };
		const histogram = recorder.metrics.histogram("duration", options);
		options.description = "Changed"; options.unit = "s"; options.boundaries.push(100);
		const values = [-2, 0, 1, 5, 6, 10, 11];
		await recorder.startSpan({ name: "request" }, (span) => {
			for (const value of values) histogram.record(value, { model: "demo" }, span);
			recorder.flush();
			histogram.record(12, { model: "demo" }, span);
		});
		const before = store.metrics("duration")[0]!;
		assert.equal(before.description, "Latency"); assert.equal(before.unit, "ms");
		assert.deepEqual(before.boundaries, [0, 5, 10]);
		assert.deepEqual(before.bucketCounts, [2, 2, 2, 2]);
		assert.deepEqual([before.count, before.sum, before.min, before.max], [8, 43, -2, 12]);
		const span = store.list()[0]!.spans[0]!;
		assert.equal(before.exemplars!.length, MAX_METRIC_EXEMPLARS);
		assert.ok(before.exemplars!.every((example) => example.traceId === span.traceId && example.spanId === span.id && example.at === at));
		recorder.stop();
		store = await TraceStore.open(root);
		assert.deepEqual(store.metrics("duration")[0], before);
		const resumed = new LiveTelemetry(store, new TracePrivacy());
		await resumed.startSpan({ name: "second" }, (span) => {
			resumed.metrics.histogram("duration", { description: "Latency", unit: "ms", boundaries: [0, 5, 10] }).record(20, { model: "demo" }, span);
		});
		const after = store.metrics("duration")[0]!;
		assert.deepEqual(after.bucketCounts, [2, 2, 2, 3]);
		assert.equal(after.count, 9); assert.equal(after.sum, 63);
		assert.deepEqual(after.exemplars!.map((example) => example.value), [0, 1, 5, 6, 10, 11, 12, 20]);
		resumed.stop();
	} finally { recorder.stop(); try { store.close(); } catch {} await rm(root, { recursive: true, force: true }); }
});

test("metric series separate metadata and boundaries, normalize attributes, and support missing contexts", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-metric-series-"));
	const store = await TraceStore.open(root);
	const recorder = new LiveTelemetry(store, new TracePrivacy());
	try {
		const plain = recorder.metrics.histogram("duration", { unit: "ms" });
		plain.record(2, { a: "one", b: "two" });
		recorder.flush(); plain.record(3, { b: "two", a: "one" }, NOOP_TELEMETRY_CONTEXT);
		recorder.metrics.histogram("duration", { unit: "ms", boundaries: [5] }).record(4, { a: "one", b: "two" });
		recorder.metrics.histogram("duration", { unit: "ms", boundaries: [10] }).record(5, { a: "one", b: "two" });
		recorder.metrics.histogram("duration", { unit: "ms", description: "Other" }).record(6, { a: "one", b: "two" });
		recorder.metrics.histogram("empty-buckets", { boundaries: [] }).record(7);
		recorder.flush();
		const rows = store.metrics("duration");
		assert.equal(rows.length, 4);
		assert.equal(rows.find((row) => !row.boundaries && !row.description)!.sum, 5);
		assert.ok(rows.every((row) => !row.exemplars));
		assert.deepEqual(store.metrics("empty-buckets")[0]!.bucketCounts, [1]);
		assert.throws(() => store.listMetrics(0), /Invalid metric page size/);
		assert.throws(() => store.listMetrics(201), /Invalid metric page size/);
		assert.equal(store.listMetrics(2).length, 2);
	} finally { recorder.stop(); await rm(root, { recursive: true, force: true }); }
});

test("legacy metric rows merge without migration and measurements stay in their own interval", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "loom-metric-legacy-"));
	const store = await TraceStore.open(root);
	let clock = Math.floor(Date.now() / 10_000) * 10_000 + 9999;
	t.mock.method(Date, "now", () => clock);
	const intervalMs = clock - 9999;
	const old = { name: "tokens", kind: "counter" as const, attributes: { model: "demo" }, intervalMs, count: 1, sum: 3, min: 3, max: 3 };
	const db = new DatabaseSync(store.path);
	db.prepare("INSERT INTO metrics VALUES (?, ?, ?)").run(intervalMs, JSON.stringify(["tokens", "counter", null, old.attributes]), JSON.stringify(old));
	db.close();
	const recorder = new LiveTelemetry(store, new TracePrivacy());
	try {
		const counter = recorder.metrics.counter("tokens");
		counter.add(2, { model: "demo" }); recorder.flush();
		assert.equal(store.metrics("tokens").length, 1);
		assert.equal(store.metrics("tokens")[0]!.sum, 5);
		clock++;
		counter.add(7, { model: "demo" }); recorder.flush();
		assert.deepEqual(store.listMetrics().map((row) => [row.intervalMs, row.sum]), [[intervalMs + 10_000, 7], [intervalMs, 5]]);
	} finally { recorder.stop(); await rm(root, { recursive: true, force: true }); }
});

test("measurement observers cannot mutate or break persisted metrics, and secrets are redacted", async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-metric-observer-"));
	const store = await TraceStore.open(root);
	const privacy = new TracePrivacy(); privacy.setSecrets(["metric-private-value"]);
	let observed = false;
	const recorder = new LiveTelemetry(store, privacy, { onMeasurement: (measurement) => {
		assert.ok(!JSON.stringify(measurement).includes("metric-private-value"));
		observed = true;
		(measurement.attributes.tags as string[]).push("mutated");
		throw new Error("diagnostic observer");
	} });
	try {
		const attrs = { tags: ["metric-private-value"] };
		recorder.metrics.histogram("duration", { description: "metric-private-value", boundaries: [5] }).record(3, attrs);
		attrs.tags.push("late"); recorder.flush();
		assert.equal(observed, true);
		const row = store.metrics("duration")[0]!;
		assert.equal(row.description, "[redacted]");
		assert.deepEqual(row.attributes.tags, ["[redacted]"]);
		store.measure = () => { throw new Error("disk unavailable"); };
		const result = {};
		assert.equal(await recorder.startSpan({ name: "operation" }, () => { recorder.metrics.counter("count").add(1); return result; }), result);
		assert.equal(await recorder.startSpan({ name: "after-failure" }, () => result), result);
	} finally { recorder.stop(); await rm(root, { recursive: true, force: true }); }
});
