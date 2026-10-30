import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LibraryPaths } from "@loom/core/paths";
import { DatabaseSync } from "node:sqlite";
import type { LoomTraceMetric, LoomTraceSpan } from "./trace-types.ts";
import { mergeMetric, metricSeries } from "./trace-metrics.ts";

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

export interface LoomTraceConversation {
	id: string;
	at: number;
	count: number;
	status: LoomTraceStatus;
	title?: string;
}

/** Missing historical conversation identities must never be merged into one fake conversation. */
export function traceConversationId(record: Pick<LoomTraceRecord, "id" | "threadId">): string {
	return record.threadId || `trace:${record.id}`;
}
const CONVERSATION_KEY = "COALESCE(NULLIF(json_extract(body, '$.threadId'), ''), 'trace:' || id)";

/** Native span snapshots plus Loom content. Legacy traces.sqlite is never opened or migrated. */
export class TraceStore {
	readonly path: string;
	private readonly db: DatabaseSync;
	private constructor(path: string, db: DatabaseSync) { this.path = path; this.db = db; }
	static async open(root: string): Promise<TraceStore> {
		const dir = new LibraryPaths(root).traces;
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
				CREATE INDEX IF NOT EXISTS traces_conversation ON traces(${CONVERSATION_KEY}, at DESC, id DESC, updated_at, status);
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
	/** Summaries only: browsing conversations never transfers every historical payload. */
	conversations(limit = 40, before?: { at: number; id: string }): LoomTraceConversation[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid conversation page size");
		const rows = this.db.prepare(`WITH retained AS (
			SELECT ${CONVERSATION_KEY} AS conversation, at, id, status FROM traces INDEXED BY traces_conversation WHERE updated_at>=?
		), grouped AS (
			SELECT conversation AS id, MAX(at) AS at, COUNT(*) AS count,
				CASE WHEN MAX(status='running') THEN 'running' ELSE
				(SELECT status FROM retained r WHERE r.conversation=t.conversation ORDER BY at DESC, id DESC LIMIT 1) END AS status
			FROM retained t GROUP BY conversation
		) SELECT * FROM grouped ${before ? "WHERE at < ? OR (at = ? AND id < ?)" : ""} ORDER BY at DESC, id DESC LIMIT ?`)
			.all(Date.now() - TRACE_RETENTION_MS, ...(before ? [before.at, before.at, before.id] : []), limit);
		return rows.map((row) => ({ id: String(row.id), at: Number(row.at), count: Number(row.count), status: row.status as LoomTraceStatus }));
	}
	conversation(id: string, limit = 40, before?: { at: number; id: string }): LoomTraceRecord[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid trace page size");
		return this.db.prepare(`SELECT body FROM traces INDEXED BY traces_conversation WHERE updated_at>=? AND ${CONVERSATION_KEY}=?
			${before ? "AND (at < ? OR (at = ? AND id < ?))" : ""} ORDER BY at DESC, id DESC LIMIT ?`)
			.all(Date.now() - TRACE_RETENTION_MS, id, ...(before ? [before.at, before.at, before.id] : []), limit)
			.map((row) => JSON.parse(String(row.body)) as LoomTraceRecord);
	}
	unfinished(): LoomTraceRecord[] {
		return this.db.prepare("SELECT body FROM traces WHERE status='running'").all().map((row) => JSON.parse(String(row.body)) as LoomTraceRecord);
	}
	measure(metric: LoomTraceMetric): void {
		const series = metricSeries(metric);
		const previous = this.db.prepare("SELECT body FROM metrics WHERE interval_ms=? AND series=?").get(metric.intervalMs, series);
		metric = mergeMetric(previous ? JSON.parse(String(previous.body)) as LoomTraceMetric : undefined, metric);
		this.db.prepare("INSERT OR REPLACE INTO metrics VALUES (?, ?, ?)").run(metric.intervalMs, series, JSON.stringify(metric));
	}
	metrics(name: string): LoomTraceMetric[] {
		return this.db.prepare("SELECT body FROM metrics WHERE interval_ms>=? AND json_extract(body, '$.name')=? ORDER BY interval_ms").all(Date.now() - TRACE_RETENTION_MS, name)
			.map((row) => JSON.parse(String(row.body)) as LoomTraceMetric);
	}
	/** Bounded newest interval rows for the development viewer, independent of trace pagination. */
	listMetrics(limit = 200): LoomTraceMetric[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid metric page size");
		return this.db.prepare("SELECT body FROM metrics WHERE interval_ms>=? ORDER BY interval_ms DESC, series LIMIT ?").all(Date.now() - TRACE_RETENTION_MS, limit)
			.map((row) => JSON.parse(String(row.body)) as LoomTraceMetric);
	}
	prune(): void {
		const cutoff = Date.now() - TRACE_RETENTION_MS;
		this.db.prepare("DELETE FROM traces WHERE updated_at<?").run(cutoff);
		this.db.prepare("DELETE FROM metrics WHERE interval_ms<?").run(cutoff);
	}
	private decode(row: Record<string, unknown> | undefined): LoomTraceRecord | undefined { return row ? JSON.parse(String(row.body)) as LoomTraceRecord : undefined; }
	close(): void { this.db.close(); }
}
