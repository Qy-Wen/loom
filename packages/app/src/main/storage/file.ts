import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { SerialQueue } from "./serial-queue.ts";

export type StorageOptions = { signal?: AbortSignal };
export const encodeJson = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;

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

const queues = new Map<string, SerialQueue>();

/** FIFO within Main, with a file lock for other instances/processes. */
export function withFileLock<T>(path: string, operation: (check: () => void) => Promise<T>, options: StorageOptions = {}): Promise<T> {
	const key = resolve(path);
	let queue = queues.get(key);
	if (!queue) { queue = new SerialQueue(); queues.set(key, queue); }
	const current = queue;
	return current.run(() => acquireFileLock(path, operation, options)).finally(() => {
		if (current.idle && queues.get(key) === current) queues.delete(key);
	});
}

/** Cross-instance/process read-modify-write lock, with heartbeat during OAuth refresh. */
async function acquireFileLock<T>(path: string, operation: (check: () => void) => Promise<T>, options: StorageOptions = {}): Promise<T> {
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
			if (Date.now() >= deadline || (code !== "ELOCKED" && !(process.platform === "win32" && code === "EPERM"))) throw new Error("Cannot acquire storage lock");
			await sleep(50, undefined, { signal: options.signal });
		}
	}
	const check = () => { if (compromised) throw new Error("Storage lock was lost"); };
	try {
		options.signal?.throwIfAborted();
		check();
		// Once an operation starts, do not discard an OAuth token rotated by a cancelled caller.
		const result = await operation(check);
		check();
		return result;
	} finally { if (!compromised) await release(); }
}

/** Set once by Main so every recovered file is written to the app log. */
let recoveryLogger: ((message: string) => void) | undefined;
export function setStorageRecoveryLogger(logger: ((message: string) => void) | undefined): void { recoveryLogger = logger; }
export function logStorage(message: string): void { recoveryLogger?.(message); }

export interface JsonFileOptions {
	/**
	 * When the file exists but is not valid JSON or fails `parse`, rename it to `<name>.corrupt-<time>` (the
	 * content is kept, not deleted) and act as if it were missing, so the app starts with defaults instead of
	 * failing. Use it where defaults let the app run. Do not use it for an installation's identity or for
	 * encrypted credentials, where a fresh start is wrong, or for files a user edits by hand, where the right
	 * response is to say what is wrong.
	 */
	recoverCorrupt?: boolean;
	/** Called with the backup path after a corrupt file has been moved aside. */
	onRecovered?: (backupPath: string, error: unknown) => void;
}

export interface JsonFileCodec<T> {
	/** Turn the parsed value into what is written to disk (for example, encrypt a field). `parse` must read both shapes. */
	serialize?: (value: T) => unknown;
}

export class JsonFile<T> {
	readonly path: string;
	readonly parse: (value: unknown) => T;
	readonly #options: JsonFileOptions & JsonFileCodec<T>;
	constructor(path: string, parse: (value: unknown) => T, options: JsonFileOptions & JsonFileCodec<T> = {}) {
		this.path = resolve(path);
		this.parse = parse;
		this.#options = options;
	}
	async read(options: StorageOptions = {}): Promise<T | undefined> {
		options.signal?.throwIfAborted();
		const text = await readOptionalFile(this.path);
		options.signal?.throwIfAborted();
		if (text === undefined) return undefined;
		try {
			return this.parse(decodeJson(text));
		} catch (error) {
			if (!this.#options.recoverCorrupt) throw error;
			await this.#moveAside(error);
			return undefined;
		}
	}
	async update<R>(change: (current: T | undefined) => Promise<{ value?: T; result: R }>, options: StorageOptions = {}): Promise<R> {
		return withFileLock(this.path, async (check) => {
			const mutation = await change(await this.read());
			check();
			if (mutation.value !== undefined) {
				const parsed = this.parse(mutation.value);
				await atomicWrite(this.path, encodeJson(this.#options.serialize ? this.#options.serialize(parsed) : parsed), check);
			}
			return mutation.result;
		}, options);
	}
	async #moveAside(error: unknown): Promise<void> {
		const backup = `${this.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		try {
			await rename(this.path, backup);
		} catch (renameError) {
			// Another process may have moved or replaced it already; only a file we cannot move is a real failure.
			if ((renameError as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		recoveryLogger?.(`Moved unreadable ${basename(this.path)} to ${basename(backup)}: ${error instanceof Error ? error.message : String(error)}`);
		this.#options.onRecovered?.(backup, error);
	}
}
