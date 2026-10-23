import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StoredMetric } from "@earendil-works/pi-telemetry";
import type { LoomTraceSpan } from "./trace-types.ts";

export const TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export type LoomTraceStatus = "running" | "completed" | "error" | "aborted" | "interrupted";
export interface LoomTraceRecord {
	id: string;
	threadId: string;
	at: number;
	revision: number;
	status: LoomTraceStatus;
	spans: LoomTraceSpan[];
	blobs?: Record<string, string>;
	settlement?: "done" | "unanswered";
	settlementReason?: string;
}

/** Native span snapshots plus Loom content. Legacy traces.sqlite is never opened or migrated. */
export class TraceStore {
	readonly path: string;
	private readonly db: DatabaseSync;
	private constructor(path: string, db: DatabaseSync) { this.path = path; this.db = db; }
	static async open(root: string): Promise<TraceStore> {
		const dir = join(root, ".agents", "traces");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, "telemetry.sqlite");
		const db = new DatabaseSync(path);
		try {
			db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
				CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
					revision INTEGER NOT NULL, status TEXT NOT NULL, submission_id INTEGER, body TEXT NOT NULL);
				CREATE INDEX IF NOT EXISTS traces_at ON traces(at DESC, id DESC);
				CREATE INDEX IF NOT EXISTS traces_updated ON traces(updated_at);
				CREATE INDEX IF NOT EXISTS traces_submission ON traces(submission_id);
				CREATE TABLE IF NOT EXISTS metrics (interval_ms INTEGER, series TEXT, body TEXT NOT NULL, PRIMARY KEY(interval_ms, series));`);
			const store = new TraceStore(path, db);
			store.prune();
			for (const record of store.unfinished()) {
				record.status = "interrupted"; record.revision++;
				record.spans = record.spans.map((span) => span.endedMs === undefined ? { ...span, endedMs: Date.now(), interrupted: true } : span);
				store.save(record);
			}
			return store;
		} catch (error) { db.close(); throw error; }
	}
	save(record: LoomTraceRecord): void {
		const submission = record.spans.find((span) => span.name === "pi.durable.submit")?.attributes["submission.id"];
		this.db.prepare(`INSERT INTO traces VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
			updated_at=excluded.updated_at, revision=excluded.revision, status=excluded.status,
			submission_id=excluded.submission_id, body=excluded.body WHERE excluded.revision > traces.revision`)
			.run(record.id, record.at, Date.now(), record.revision, record.status, typeof submission === "number" ? submission : null, JSON.stringify(record));
	}
	get(id: string): LoomTraceRecord | undefined {
		return this.decode(this.db.prepare("SELECT body FROM traces WHERE id=? AND updated_at>=?").get(id, Date.now() - TRACE_RETENTION_MS));
	}
	forSubmission(id: number): LoomTraceRecord | undefined {
		return this.decode(this.db.prepare("SELECT body FROM traces WHERE submission_id=? AND updated_at>=?").get(id, Date.now() - TRACE_RETENTION_MS));
	}
	list(limit = 40, before?: { at: number; id: string }): LoomTraceRecord[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid trace page size");
		const cutoff = Date.now() - TRACE_RETENTION_MS;
		const rows = before
			? this.db.prepare("SELECT body FROM traces WHERE updated_at>=? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?").all(cutoff, before.at, before.at, before.id, limit)
			: this.db.prepare("SELECT body FROM traces WHERE updated_at>=? ORDER BY at DESC, id DESC LIMIT ?").all(cutoff, limit);
		return rows.map((row) => JSON.parse(String(row.body)) as LoomTraceRecord);
	}
	unfinished(): LoomTraceRecord[] {
		return this.db.prepare("SELECT body FROM traces WHERE status='running'").all().map((row) => JSON.parse(String(row.body)) as LoomTraceRecord);
	}
	measure(metric: StoredMetric): void {
		const attributes = Object.fromEntries(Object.entries(metric.attributes).sort(([a], [b]) => a.localeCompare(b)));
		const series = JSON.stringify([metric.name, metric.kind, metric.unit, attributes]);
		const previous = this.db.prepare("SELECT body FROM metrics WHERE interval_ms=? AND series=?").get(metric.intervalMs, series);
		if (previous) {
			const old = JSON.parse(String(previous.body)) as StoredMetric;
			metric = { ...metric, count: old.count + metric.count, sum: old.sum + metric.sum, min: Math.min(old.min, metric.min), max: Math.max(old.max, metric.max) };
		}
		this.db.prepare("INSERT OR REPLACE INTO metrics VALUES (?, ?, ?)").run(metric.intervalMs, series, JSON.stringify(metric));
	}
	metrics(name: string): StoredMetric[] {
		return this.db.prepare("SELECT body FROM metrics WHERE interval_ms>=? ORDER BY interval_ms").all(Date.now() - TRACE_RETENTION_MS)
			.map((row) => JSON.parse(String(row.body)) as StoredMetric).filter((row) => row.name === name);
	}
	prune(): void {
		const cutoff = Date.now() - TRACE_RETENTION_MS;
		this.db.prepare("DELETE FROM traces WHERE updated_at<?").run(cutoff);
		this.db.prepare("DELETE FROM metrics WHERE interval_ms<?").run(cutoff);
	}
	private decode(row: Record<string, unknown> | undefined): LoomTraceRecord | undefined { return row ? JSON.parse(String(row.body)) as LoomTraceRecord : undefined; }
	close(): void { this.db.close(); }
}
