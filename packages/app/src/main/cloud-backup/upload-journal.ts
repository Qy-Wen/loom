import { appendFile, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CloudConfig } from "../../shared/cloud-backup.ts";
import { atomicWrite, withFileLock } from "../storage/file.ts";
import { SerialQueue } from "../storage/serial-queue.ts";
import { validateBackupPath } from "./snapshot.ts";

export type UploadedFile = { path: string; size: number; mtimeMs: number; hash: string; etag: string };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_HEADER = 64 * 1024 * 1024, MAX_JOURNAL = 2 * MAX_HEADER;

export function uploadJournalPath(directory: string, config: CloudConfig, libraryId: string): string {
	if (!UUID.test(libraryId)) throw new Error("Invalid backup library ID");
	const scope = createHash("sha256").update(JSON.stringify(config)).digest("hex");
	return join(directory, scope, `${libraryId}.jsonl`);
}
function fileRecord(input: unknown): UploadedFile {
	const file = input as UploadedFile;
	if (!file || !/^[a-f0-9]{64}$/.test(file.hash) || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isFinite(file.mtimeMs) || Math.abs(file.mtimeMs) > 8.64e15 || typeof file.etag !== "string" || !file.etag || file.etag.length > 1024) throw new Error("Invalid upload checkpoint");
	validateBackupPath(file.path, false);
	return { path: file.path, size: file.size, mtimeMs: file.mtimeMs, hash: file.hash, etag: file.etag };
}

/** One local, destination-scoped log. Only files verified against the matching cloud revision are reusable. */
export class UploadJournal {
	readonly #path: string;
	readonly #libraryId: string;
	readonly #queue = new SerialQueue();
	readonly #check: () => void;
	#failed = false;
	constructor(path: string, libraryId: string, check: () => void) { this.#path = path; this.#libraryId = libraryId; this.#check = check; }
	check(): void { this.#check(); }
	async read(revision: string): Promise<UploadedFile[]> {
		let bytes: string;
		try {
			if ((await stat(this.#path)).size > MAX_JOURNAL) return [];
			bytes = await readFile(this.#path, "utf8");
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		if (Buffer.byteLength(bytes) > MAX_JOURNAL) return [];
		try {
			const lines = bytes.split("\n"), header = JSON.parse(lines[0]!);
			if (header.format !== 1 || header.libraryId !== this.#libraryId || header.revision !== revision || !Array.isArray(header.files)) return [];
			const files = new Map<string, UploadedFile>();
			for (const input of header.files) { const file = fileRecord(input); files.set(file.path, file); }
			for (let index = 1; index < lines.length; index++) {
				if (!lines[index]) continue;
				try { const file = fileRecord(JSON.parse(lines[index]!)); files.set(file.path, file); }
				catch (error) { if (index !== lines.length - 1) throw error; /* A crash can leave the final append incomplete. */ }
			}
			return [...files.values()];
		} catch { return []; /* A damaged cache never substitutes for source/remote verification. */ }
	}
	async begin(revision: string, files: Iterable<UploadedFile>): Promise<void> {
		const header = `${JSON.stringify({ format: 1, libraryId: this.#libraryId, revision, files: [...files].map(fileRecord) })}\n`;
		if (Buffer.byteLength(header) > MAX_HEADER) throw new Error("Backup resume state is too large");
		await atomicWrite(this.#path, header, this.#check);
	}
	record(file: UploadedFile): Promise<void> {
		return this.#queue.run(async () => {
			this.#check();
			if (this.#failed) throw new Error("Cannot save backup progress");
			try { await appendFile(this.#path, `${JSON.stringify(fileRecord(file))}\n`, { mode: 0o600 }); }
			catch (error) { this.#failed = true; throw error; }
		});
	}
	async clear(): Promise<void> {
		await this.flush(); this.#check();
		// A leftover log is ignored when the catalog is ready, so cleanup cannot invalidate a completed backup.
		await rm(this.#path, { force: true, maxRetries: 3 }).catch(() => {});
	}
	async flush(): Promise<void> { await this.#queue.run(async () => {}); }
}

export async function withUploadJournal<T>(path: string, libraryId: string, signal: AbortSignal, run: (journal: UploadJournal) => Promise<T>): Promise<T> {
	return withFileLock(path, async (check) => {
		const journal = new UploadJournal(path, libraryId, check);
		try { return await run(journal); }
		finally { await journal.flush(); }
	}, { signal });
}
