import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { assertJson } from "@loom/agent/chat-models";

export type StorageOptions = { signal?: AbortSignal };
export function validateStorageId(id: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) throw new Error("Invalid Chat storage identifier");
}
export const encodeJson = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;

/** Native TS objects may omit optional fields by setting undefined; reject other non-JSON values. */
export function normalizeStorageJson(value: unknown): unknown {
	const active = new Set<object>();
	const visit = (value: unknown, depth: number): unknown => {
		if (!value || typeof value !== "object") return value;
		if (depth > 64 || active.has(value)) throw new Error("Invalid JSON storage value");
		if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Invalid JSON storage object");
		active.add(value);
		const result = Array.isArray(value) ? Array.from(value, (entry) => visit(entry, depth + 1))
			: Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, visit(entry, depth + 1)]));
		active.delete(value); return result;
	};
	const normalized = visit(value, 0); assertJson(normalized); return normalized;
}

export async function readOptionalFile(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function decodeJson(text: string): unknown {
	try { return JSON.parse(text); } catch { throw new Error("Invalid JSON storage file"); }
}

/** Replace, never unlink the destination first; temporary files contain only the supplied safe payload. */
export async function atomicWrite(path: string, contents: string | Uint8Array, beforeCommit: () => void = () => {}): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, "wx", 0o600);
		try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
		for (let attempt = 0; ; attempt++) {
			try { beforeCommit(); await rename(temporary, path); break; }
			catch (error) {
				if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				await sleep(20 * (attempt + 1));
			}
		}
		// Persist the rename on POSIX. Windows does not support opening directories for fsync.
		if (process.platform !== "win32") {
			const directory = await open(dirname(path), "r");
			try { await directory.sync(); } finally { await directory.close(); }
		}
	} finally { await rm(temporary, { force: true, maxRetries: 3, retryDelay: 100 }); }
}

/** Cross-instance/process read-modify-write lock, with heartbeat during OAuth refresh. */
export async function withFileLock<T>(path: string, operation: (check: () => void) => Promise<T>, options: StorageOptions = {}): Promise<T> {
	options.signal?.throwIfAborted();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	// Canonicalize directory aliases so two clients cannot acquire different locks for the same file.
	const canonical = join(await realpath(dirname(resolve(path))), basename(path));
	let compromised: Error | undefined;
	let release: (() => Promise<void>) | undefined;
	const deadline = Date.now() + 30_000;
	while (!release) {
		options.signal?.throwIfAborted();
		try {
			release = await lockfile.lock(canonical, { realpath: false, stale: 30_000, update: 5000, retries: 0,
				onCompromised: (error) => { compromised = error; },
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (Date.now() >= deadline || (code !== "ELOCKED" && !(process.platform === "win32" && code === "EPERM"))) throw new Error("Cannot acquire Chat storage lock");
			await sleep(50, undefined, { signal: options.signal });
		}
	}
	const check = () => { if (compromised) throw new Error("Chat storage lock was lost"); };
	try {
		options.signal?.throwIfAborted();
		check();
		// Once an operation starts, do not discard an OAuth token rotated by a cancelled caller.
		const result = await operation(check);
		check();
		return result;
	} finally { if (!compromised) await release(); }
}

export class ChatJsonFile<T> {
	readonly path: string;
	readonly parse: (value: unknown) => T;
	constructor(path: string, parse: (value: unknown) => T) { this.path = resolve(path); this.parse = parse; }
	async read(options: StorageOptions = {}): Promise<T | undefined> {
		options.signal?.throwIfAborted();
		const text = await readOptionalFile(this.path);
		options.signal?.throwIfAborted();
		return text === undefined ? undefined : this.parse(decodeJson(text));
	}
	async update<R>(change: (current: T | undefined) => Promise<{ value?: T; result: R }>, options: StorageOptions = {}): Promise<R> {
		return withFileLock(this.path, async (check) => {
			const mutation = await change(await this.read());
			check();
			if (mutation.value !== undefined) await atomicWrite(this.path, encodeJson(this.parse(mutation.value)), check);
			return mutation.result;
		}, options);
	}
}
