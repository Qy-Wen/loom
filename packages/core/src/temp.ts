import { mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loom's one directory under the OS temp dir. Every temp file or folder Loom makes lives below it, in a
 * subdirectory named for its purpose, so the OS temp dir never fills with scattered `loom-*` entries.
 */
export const TEMP_ROOT_NAME = "loom";
/** Entries older than this are leftovers of a crash; `sweepStaleTemp()` removes them. */
export const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

/**
 * `<os tmpdir>/loom`, created if missing. `os.tmpdir()` only reads TMPDIR (macOS/Linux) or TEMP/TMP (Windows)
 * and never checks the directory exists, so a custom value can point at a folder nobody made.
 */
export async function ensureTempRoot(): Promise<string> {
	const root = join(tmpdir(), TEMP_ROOT_NAME);
	await mkdir(root, { recursive: true, mode: 0o700 });
	return root;
}

export function ensureTempRootSync(): string {
	const root = join(tmpdir(), TEMP_ROOT_NAME);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

/** `<root>/<purpose>`, created if missing. For files shared across calls, such as the sandbox helper. */
export async function ensureTempDir(purpose: string): Promise<string> {
	const dir = join(await ensureTempRoot(), purpose);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** A fresh private directory `<root>/<purpose>/<random>`. The caller removes it. */
export async function makeTempDir(purpose: string): Promise<string> {
	return mkdtemp(join(await ensureTempDir(purpose), "run-"));
}

/**
 * Remove entries under `<root>` whose newest change is older than `STALE_TEMP_MS`. Best effort: a locked or
 * missing entry is skipped, and an error never reaches the caller.
 */
export async function sweepStaleTemp(now = Date.now()): Promise<void> {
	try {
		const root = await ensureTempRoot();
		for (const purpose of await readdir(root)) {
			const dir = join(root, purpose);
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch {
				continue;
			}
			for (const entry of entries) {
				const path = join(dir, entry);
				try {
					if (now - (await stat(path)).mtimeMs > STALE_TEMP_MS) await rm(path, { recursive: true, force: true });
				} catch { /* in use or already gone */ }
			}
		}
	} catch { /* temp cleanup must never fail the caller */ }
}
