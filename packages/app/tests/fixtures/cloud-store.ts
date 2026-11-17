import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { ObjectStore } from "../../src/main/cloud-backup/object-store.ts";

export class MemoryStore implements ObjectStore {
	objects = new Map<string, Buffer>();
	uploads: string[] = [];
	fail?: (key: string) => boolean;
	afterDownload?: (key: string) => void;
	removed: string[] = [];
	failRemove?: (key: string) => boolean;
	async head(key: string, signal: AbortSignal) { signal.throwIfAborted(); const bytes = this.objects.get(key); return bytes ? { size: bytes.length, etag: createHash("sha256").update(bytes).digest("hex") } : undefined; }
	async remove(key: string, signal: AbortSignal) { signal.throwIfAborted(); if (this.failRemove?.(key)) throw new Error("Simulated delete failure"); this.removed.push(key); this.objects.delete(key); }
	async upload(key: string, path: string, signal: AbortSignal, progress?: (bytes: number) => void) {
		signal.throwIfAborted();
		if (this.fail?.(key)) throw new Error("Simulated upload failure");
		const bytes = await readFile(path); this.objects.set(key, bytes); this.uploads.push(key); progress?.(bytes.length);
	}
	async download(key: string, path: string, signal: AbortSignal, limit: number, progress?: (bytes: number) => void) {
		signal.throwIfAborted(); const bytes = this.objects.get(key);
		if (!bytes) throw new Error("Object missing");
		if (bytes.length > limit) throw new Error("Object exceeds limit");
		await writeFile(path, bytes); progress?.(bytes.length); this.afterDownload?.(key);
	}
	async *list(prefix: string, signal: AbortSignal) { for (const key of this.objects.keys()) { signal.throwIfAborted(); if (key.startsWith(prefix)) yield key; } }
}
