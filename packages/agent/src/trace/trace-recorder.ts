import { randomUUID } from "node:crypto";
import { NOOP_TELEMETRY_CONTEXT, type SpanAttributes, type SpanOptions, type StoredMetric, type TelemetryCarrier,
	type TelemetryContext, type TelemetryMetrics, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import type { LoomTraceSpan } from "./trace-types.ts";
import { TraceStore, type LoomTraceRecord, type LoomTraceStatus } from "./trace-store.ts";
import { TracePrivacy } from "./trace-privacy.ts";

type Span = { -readonly [K in keyof LoomTraceSpan]: LoomTraceSpan[K] };
type Identity = { id: string; traceId: string; conversation?: string };
type ActiveTrace = { record: LoomTraceRecord; dirty: boolean };

/** Backend for Pi's native telemetry contract. Owns recording, never task/request instrumentation. */
export class LiveTelemetry implements TelemetryContext {
	private readonly identities = new WeakMap<TelemetryContext, Identity>();
	private readonly traces = new Map<string, ActiveTrace>();
	private readonly measurements = new Map<string, StoredMetric>();
	private readonly scope = randomUUID();
	private readonly timeOrigin = Date.now() - performance.now();
	private sequence = 0;
	private stopped = false;
	private failed = false;
	private timer?: ReturnType<typeof setTimeout>;
	private readonly cleanup: ReturnType<typeof setInterval>;
	readonly store: TraceStore;
	readonly privacy: TracePrivacy;
	private readonly publish: (record: LoomTraceRecord) => void;
	private readonly report: (error: unknown) => void;
	private readonly summarize: (record: LoomTraceRecord) => LoomTraceStatus;
	constructor(store: TraceStore, privacy: TracePrivacy, publish: (record: LoomTraceRecord) => void = () => {}, report: (error: unknown) => void = () => {},
		summarize: (record: LoomTraceRecord) => LoomTraceStatus = spanStatus) {
		this.store = store; this.privacy = privacy; this.publish = publish; this.report = report;
		this.summarize = summarize;
		this.cleanup = setInterval(() => this.observe(() => store.prune()), 60_000);
		this.cleanup.unref();
	}
	readonly propagation = {
		inject: (context: TelemetryContext): TelemetryCarrier | undefined => {
			const identity = this.identities.get(context);
			return identity ? { "loom.trace": identity.traceId, "loom.span": identity.id, ...(identity.conversation ? { "loom.conversation": identity.conversation } : {}) } : undefined;
		},
		extract: (carrier: TelemetryCarrier | undefined): TelemetryContext => {
			if (!carrier?.["loom.trace"] || !carrier["loom.span"]) return this;
			const identity = { traceId: carrier["loom.trace"], id: carrier["loom.span"], conversation: carrier["loom.conversation"] };
			const parent: TelemetryContext = { metrics: this.metrics, propagation: this.propagation, startSpan: (options, callback) => this.start(identity, options, callback) };
			this.identities.set(parent, identity);
			return parent;
		},
	};
	readonly metrics: TelemetryMetrics = {
		counter: (name, options) => ({ add: (value, attrs) => this.measure(name, "counter", value, attrs, options?.unit) }),
		upDownCounter: (name, options) => ({ add: (value, attrs) => this.measure(name, "upDownCounter", value, attrs, options?.unit) }),
		histogram: (name, options) => ({ record: (value, attrs) => this.measure(name, "histogram", value, attrs, options?.unit) }),
	};
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> { return this.start(undefined, options, callback); }
	private inert<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return NOOP_TELEMETRY_CONTEXT.startSpan(options, (noop) => callback({
			...noop, metrics: this.metrics, propagation: this.propagation, startSpan: (options, callback) => this.inert(options, callback),
		}));
	}
	private async start<T>(parent: Identity | undefined, options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		if (this.stopped || this.failed) return this.inert(options, callback);
		const id = `${this.scope}:${++this.sequence}`;
		const identity: Identity = { id, traceId: parent?.traceId ?? id, conversation: parent?.conversation };
		const nativeConversation = options.attributes?.["conversation.id"];
		if (typeof nativeConversation === "number") identity.conversation = String(nativeConversation);
		const record = this.observe(() => this.record(identity));
		if (!record) return this.inert(options, callback);
		const clock = performance.now();
		const row: Span = { id, traceId: identity.traceId, ...(parent ? { parentId: parent.id } : {}), name: options.name,
			startedMs: this.timeOrigin + clock, attributes: this.observe(() => this.attributes(options.attributes)) ?? {}, events: [], links: [], status: { status: "ok" } };
		record.spans.push(row);
		let settled = false; let explicit = false;
		const write = (operation: () => void) => { if (!settled && !this.stopped && !this.failed) this.observe(() => { operation(); this.dirty(record); }); };
		const link = (context: TelemetryContext, attributes?: SpanAttributes) => {
			const target = this.identities.get(context);
			if (target) row.links = [...row.links, { traceId: target.traceId, spanId: target.id, attributes: this.attributes(attributes) }];
		};
		for (const item of options.links ?? []) this.observe(() => link(item.context, item.attributes));
		const span: TelemetrySpan = {
			metrics: this.metrics, propagation: this.propagation,
			startSpan: (options, callback) => settled ? this.inert(options, callback) : this.start(identity, options, callback),
			addLink: (item) => write(() => link(item.context, item.attributes)),
			setAttributes: (attributes) => write(() => {
				row.attributes = { ...row.attributes, ...this.attributes(attributes) };
				const conversation = attributes["conversation.id"];
				if (typeof conversation === "number") { identity.conversation = String(conversation); record.threadId ||= String(conversation); }
			}),
			setStatus: (status) => write(() => {
				row.status = status.status === "ok" ? { status: "ok" } : { status: "error", ...(status.error ? { error: { name: this.privacy.text(status.error.name), message: this.privacy.text(status.error.message) } } : {}) };
				explicit = true;
			}),
			addEvent: (name, attributes) => write(() => {
				row.events = [...row.events, { name, timeMs: performance.now() - clock, attributes: this.attributes(attributes) }];
			}),
		};
		this.identities.set(span, identity);
		this.observe(() => { this.dirty(record); this.flush(); });
		try { return await callback(span); }
		catch (error) {
			if (!explicit) this.observe(() => { row.status = { status: "error", ...(error instanceof Error ? { error: { name: this.privacy.text(error.name), message: this.privacy.text(error.message) } } : {}) }; });
			throw error;
		} finally {
			settled = true;
			if (!this.stopped && !this.failed) this.observe(() => { row.endedMs = this.timeOrigin + performance.now(); this.dirty(record); this.flush(); });
		}
	}
	/** Supplemental content may arrive just after a native request's callback settled. */
	content(context: TelemetryContext, attributes: SpanAttributes, blobs?: Record<string, string>): void {
		this.observe(() => {
			if (this.stopped || this.failed) return;
			const identity = this.identities.get(context); if (!identity) return;
			const record = this.record(identity);
			const span = record.spans.find((span) => span.id === identity.id) as Span | undefined;
			if (!span) return;
			span.attributes = { ...span.attributes, ...attributes };
			if (blobs && Object.keys(blobs).length) record.blobs = { ...record.blobs, ...blobs };
			this.dirty(record);
		});
	}
	private record(identity: Identity): LoomTraceRecord {
		let active = this.traces.get(identity.traceId);
		if (!active) {
			const saved = this.store.get(identity.traceId);
			active = { record: saved ?? { id: identity.traceId, threadId: identity.conversation ?? "", at: Date.now(), revision: 0, status: "running", spans: [] }, dirty: false };
			this.traces.set(identity.traceId, active);
		}
		active.record.threadId ||= identity.conversation ?? "";
		return active.record;
	}
	/** Apply application metadata without replacing active span objects. */
	updateTrace(id: string, update: (record: LoomTraceRecord) => void): void {
		this.observe(() => {
			if (this.stopped || this.failed) return;
			const record = this.traces.get(id)?.record ?? this.store.get(id);
			if (!record) return;
			if (!this.traces.has(id)) this.traces.set(id, { record, dirty: false });
			update(record); this.dirty(record);
		});
	}
	private attributes(attributes: SpanAttributes | undefined): SpanAttributes {
		return structuredClone(this.privacy.attributes(attributes ?? {}));
	}
	private dirty(record: LoomTraceRecord): void {
		const active = this.traces.get(record.id); if (!active) return;
		active.dirty = true;
		record.status = this.summarize(record);
		this.schedule();
	}
	private schedule(): void {
		if (this.timer || this.stopped || this.failed) return;
		this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 100); this.timer.unref();
	}
	private measure(name: string, kind: StoredMetric["kind"], value: number, attributes?: SpanAttributes, unit?: string): void {
		this.observe(() => {
			if (this.stopped || this.failed) return;
			const attrs = this.attributes(attributes);
			const intervalMs = Math.floor(Date.now() / 10_000) * 10_000;
			const key = JSON.stringify([intervalMs, name, kind, unit, Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))]);
			const previous = this.measurements.get(key);
			if (!previous && this.measurements.size >= 10_000) return;
			this.measurements.set(key, { name, kind, unit, attributes: attrs, intervalMs, count: (previous?.count ?? 0) + 1,
				sum: (previous?.sum ?? 0) + value, min: Math.min(previous?.min ?? value, value), max: Math.max(previous?.max ?? value, value) });
			this.schedule();
		});
	}
	flush(): void {
		if (this.failed) return;
		for (const [id, active] of this.traces) if (active.dirty) this.observe(() => {
			active.record.revision++;
			if (!this.persist(() => this.store.save(active.record))) return;
			active.dirty = false;
			this.observe(() => this.publish(structuredClone(active.record)));
			if (active.record.status !== "running" && active.record.spans.every((span) => span.endedMs !== undefined)) this.traces.delete(id);
		});
		for (const [key, metric] of this.measurements) {
			if (!this.persist(() => this.store.measure(metric))) return;
			this.measurements.delete(key);
		}
	}
	private persist(operation: () => void): boolean {
		try { operation(); return true; }
		catch (error) {
			this.failed = true; clearTimeout(this.timer); clearInterval(this.cleanup);
			this.traces.clear(); this.measurements.clear(); this.observe(() => this.report(error)); return false;
		}
	}
	stop(): void {
		if (this.stopped) return;
		this.stopped = true; clearTimeout(this.timer); clearInterval(this.cleanup);
		for (const active of this.traces.values()) if (active.record.status === "running") {
			active.record.status = "interrupted"; active.dirty = true;
			active.record.spans = active.record.spans.map((span) => span.endedMs === undefined ? { ...span, endedMs: Date.now(), interrupted: true } : span);
		}
		this.flush(); this.traces.clear(); this.measurements.clear(); this.observe(() => this.store.close());
	}
	private observe<T>(operation: () => T): T | undefined { try { return operation(); } catch (error) { try { this.report(error); } catch {} return undefined; } }
}

function spanStatus(record: LoomTraceRecord): LoomTraceStatus {
	if (record.spans.some((span) => span.endedMs === undefined)) return "running";
	return record.spans.some((span) => span.status.status === "error") ? "error" : "completed";
}
