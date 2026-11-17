import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CloudJob } from "../../shared/cloud-backup.ts";
type Fingerprint = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number };
type SourceFile = Fingerprint & { path: string; source: string };
export type Snapshot = { root: string; sourceRoot: string; temporary: string; libraryId: string; directories: string[]; files: SourceFile[] };
export type Progress = (patch: Partial<CloudJob>) => void;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESTORE_MARKER = ".loom/backup/restore.json";

function included(path: string): boolean {
	if (path.split("/").at(-1) === ".DS_Store") return false;
	if (!path.startsWith(".loom/")) return true;
	return [".loom/metadata-db", ".loom/graph-db", ".loom/grades", ".loom/agents/sessions", ".loom/agents/skills", ".loom/agents/memory", ".loom/agents/tool-results", ".loom/backup/identity.json"].some((base) => path === base || path.startsWith(`${base}/`) || base.startsWith(`${path}/`));
}
function fingerprint(value: Fingerprint): Fingerprint { return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, ino: value.ino, dev: value.dev }; }
function same(a: Fingerprint, b: Fingerprint): boolean { return Object.keys(fingerprint(a)).every((key) => a[key as keyof Fingerprint] === b[key as keyof Fingerprint]); }
export function validateRelativePath(path: string, windows = process.platform === "win32"): void {
	if (typeof path !== "string" || !path || path.length > 4096 || /[\\\x00-\x1f]/.test(path) || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || /^[a-z]:/i.test(path)) throw new Error("Unsafe path in backup");
	if (windows && path.split("/").some((part) => /[<>:"|?*]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`File name is incompatible with Windows: ${path}`);
}
export function validateBackupPath(path: string, windows = process.platform === "win32"): void {
	validateRelativePath(path, windows);
	if (!included(path) || path === RESTORE_MARKER) throw new Error("Unexpected private metadata in backup");
}

/** Called only after BOTH Core and Chat storage have closed. No live SQLite/WASM files are copied. */
export async function captureSnapshot(root: string, signal: AbortSignal): Promise<Snapshot> {
	const sourceRoot = root;
	root = await realpath(root);
	const temporary = await mkdtemp(join(tmpdir(), "loom-backup-"));
	try {
		const identityPath = join(root, ".loom/backup/identity.json");
		for (const path of [join(root, ".loom"), dirname(identityPath), identityPath]) {
			try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Backup metadata cannot be a symbolic link"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		await mkdir(dirname(identityPath), { recursive: true });
		let libraryId: string;
		try { libraryId = JSON.parse(await readFile(identityPath, "utf8")).id; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			libraryId = randomUUID();
			await writeFile(identityPath, JSON.stringify({ id: libraryId }), { flag: "wx" });
		}
		if (!UUID.test(libraryId)) throw new Error("Invalid library backup identity");
		const files: SourceFile[] = [], directories: string[] = [];
		const portablePaths = new Set<string>();
		async function walk(relative: string): Promise<void> {
			for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
				signal.throwIfAborted();
				const path = relative ? `${relative}/${entry.name}` : entry.name;
				if (!included(path)) continue;
				validateBackupPath(path, false);
				const portable = path.normalize("NFC").toLowerCase();
				if (portablePaths.has(portable)) throw new Error(`Case or Unicode-conflicting file name: ${path}`);
				portablePaths.add(portable);
				const source = join(root, path);
				const stat = await lstat(source);
				if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Backup does not support links or special files: ${path}`);
				if (stat.isDirectory()) { directories.push(path); await walk(path); continue; }
				// SQLite has closed: an outstanding WAL is data, not a disposable cache.
				// Keep it if present; only transient shared-memory/lock files are excluded.
				if (path.startsWith(".loom/") && (path.endsWith("-shm") || path.endsWith(".lock"))) continue;
				if (path.startsWith(".loom/")) {
					const staged = join(temporary, "metadata", path);
					await mkdir(dirname(staged), { recursive: true });
					await copyFile(source, staged);
					if (!same(stat, await lstat(source))) throw new Error(`Metadata changed during backup. Retry: ${path}`);
					await utimes(staged, stat.atime, stat.mtime);
					const copied = await lstat(staged);
					files.push({ path, source: staged, ...fingerprint(copied) });
				} else files.push({ path, source, ...fingerprint(stat) });
			}
		}
		await walk("");
		return { root, sourceRoot, temporary, libraryId, files, directories };
	} catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function hashFile(file: string, signal: AbortSignal): Promise<{ hash: string; size: number }> {
	const hash = createHash("sha256"); let size = 0;
	for await (const chunk of createReadStream(file, { signal })) { hash.update(chunk); size += chunk.length; }
	return { hash: hash.digest("hex"), size };
}
/** Stage one stable file so the provider uploads exactly the bytes whose hash was calculated. */
export async function stageSnapshotFile(file: Snapshot["files"][number], target: string, signal: AbortSignal): Promise<{ path: string; size: number; mtimeMs: number; hash: string }> {
	signal.throwIfAborted();
	const stat = await lstat(file.source);
	if (!stat.isFile() || !same(file, stat)) throw new Error(`File changed during backup. Retry: ${file.path}`);
	const hash = createHash("sha256"); let size = 0;
	await pipeline(createReadStream(file.source), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); size += chunk.length; callback(null, chunk); } }), createWriteStream(target, { mode: 0o600 }), { signal });
	if (size !== file.size || !same(file, await lstat(file.source))) throw new Error(`File changed during backup. Retry: ${file.path}`);
	return { path: file.path, size, mtimeMs: file.mtimeMs, hash: hash.digest("hex") };
}

/** Conversation working directories are persisted as absolute paths. Map descendants across OSes. */
export function relocatedCwd(cwd: string | undefined, sourceRoot: string, root: string, aliases: string[] = []): string {
	if (!cwd) return root;
	for (const source of [sourceRoot, ...aliases]) {
		const mapped = mapCwd(cwd, source, root);
		if (mapped) return mapped;
	}
	// A directory outside the original library belongs to the old computer.
	return root;
}
function mapCwd(cwd: string, sourceRoot: string, root: string): string | undefined {
	const old = sourceRoot.replace(/\\/g, "/").replace(/\/$/, "");
	const value = cwd.replace(/\\/g, "/");
	const windows = win32.isAbsolute(sourceRoot) && (/^[a-z]:/i.test(sourceRoot) || sourceRoot.startsWith("\\\\"));
	const normalized = windows ? value.toLowerCase() : value;
	const prefix = windows ? old.toLowerCase() : old;
	if (normalized === prefix) return root;
	if (normalized.startsWith(`${prefix}/`)) {
		const suffix = value.slice(old.length + 1);
		if (suffix.split("/").every((part) => part && part !== "." && part !== "..")) return join(root, ...suffix.split("/"));
	}
	return undefined;
}

export async function readRestoreMarker(root: string): Promise<{ sourceRoot: string; sourceAliases: string[] } | undefined> {
	try {
		const marker = JSON.parse(await readFile(join(root, RESTORE_MARKER), "utf8"));
		if (marker.version !== 1 || typeof marker.sourceRoot !== "string" || !Array.isArray(marker.sourceAliases) || marker.sourceAliases.length > 20 || marker.sourceAliases.some((p: unknown) => typeof p !== "string")) throw new Error("Invalid backup restore marker");
		return marker;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function clearRestoreMarker(root: string): Promise<void> { await rm(join(root, RESTORE_MARKER), { force: true }); }
