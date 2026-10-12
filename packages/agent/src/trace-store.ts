import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LoomTraceSpan } from "./trace-types.ts";

export type LoomTraceStatus = "running" | "completed" | "error" | "aborted" | "interrupted";
export interface LoomTraceRecord {
	id: string;
	threadId: string;
	at: number;
	revision: number;
	status: LoomTraceStatus;
	spans: LoomTraceSpan[];
}

/** Local diagnostic store, independent of durable checkpoints. No automatic history deletion. */
export class TraceStore {
	readonly path: string;
	private readonly db: DatabaseSync;
	private constructor(path: string, db: DatabaseSync) { this.path = path; this.db = db; }
	static async open(root: string): Promise<TraceStore> {
		const dir = join(root, ".agents", "traces");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, "traces.sqlite");
		const db = new DatabaseSync(path);
		try {
			db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
				CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, at INTEGER NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
				CREATE INDEX IF NOT EXISTS traces_at ON traces(at DESC);`);
			return new TraceStore(path, db);
		} catch (error) { db.close(); throw error; }
	}
	save(record: LoomTraceRecord): void {
		this.db.prepare("INSERT INTO traces VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, status=excluded.status, body=excluded.body WHERE excluded.revision > traces.revision")
			.run(record.id, record.at, record.revision, record.status, JSON.stringify(record));
	}
	get(id: string): LoomTraceRecord | undefined {
		const row = this.db.prepare("SELECT body FROM traces WHERE id=?").get(id);
		return row ? JSON.parse(String(row.body)) as LoomTraceRecord : undefined;
	}
	list(limit = 40, before?: { at: number; id: string }): LoomTraceRecord[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid trace page size");
		const rows = before
			? this.db.prepare("SELECT body FROM traces WHERE at < ? OR (at = ? AND id < ?) ORDER BY at DESC, id DESC LIMIT ?").all(before.at, before.at, before.id, limit)
			: this.db.prepare("SELECT body FROM traces ORDER BY at DESC, id DESC LIMIT ?").all(limit);
		return rows.map((row) => JSON.parse(String(row.body)) as LoomTraceRecord);
	}
	unfinished(): LoomTraceRecord[] {
		return this.db.prepare("SELECT body FROM traces WHERE status = 'running'").all().map((row) => JSON.parse(String(row.body)) as LoomTraceRecord);
	}
	close(): void { this.db.close(); }
}
