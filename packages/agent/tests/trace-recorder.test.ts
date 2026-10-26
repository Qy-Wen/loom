import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import { TraceStore, TRACE_RETENTION_MS } from "../src/trace/trace-store.ts";
import { LiveTelemetry } from "../src/trace/trace-recorder.ts";
import { TracePrivacy } from "../src/trace/trace-privacy.ts";

for (const probe of createTelemetryAdapterConformance(async () => {
	const root = await mkdtemp(join(tmpdir(), "loom-telemetry-contract-"));
	const store = await TraceStore.open(root);
	const recorder = new LiveTelemetry(store, new TracePrivacy());
	return {
		context: recorder, propagation: recorder.propagation,
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
		assert.equal(store.get("old"), undefined); assert.equal(store.list().length, 0); assert.equal(store.metrics("tokens").length, 0);
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
	const recorder = new LiveTelemetry(store, new TracePrivacy(), () => { throw new Error("publisher"); }, () => { failures++; });
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
