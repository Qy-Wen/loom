import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isAssetTemporaryFile } from "@loom/core/paths";
import type { CloudJob } from "../../shared/cloud-backup.ts";
export type FileStamp = { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number };
type SourceFile = FileStamp & { path: string; source: string; original?: FileStamp; hash?: string };
export type Snapshot = { root: string; sourceRoot: string; temporary: string; libraryId: string; directories: string[]; files: SourceFile[] };
export type Progress = (patch: Partial<CloudJob>) => void;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESTORE_MARKER = ".loom/backup/restore.json";
export const PERSISTENT_ROOTS = [".loom/metadata-db", ".loom/graph-db", ".loom/grades", ".loom/agents/sessions", ".loom/agents/skills", ".loom/agents/memory", ".loom/agents/tool-results", ".loom/backup/identity.json"];

export function included(path: string): boolean {
	if (path.split("/").at(-1) === ".DS_Store" || isAssetTemporaryFile(path)) return false;
	if (!path.startsWith(".loom/")) return true;
	return PERSISTENT_ROOTS.some((base) => path === base || path.startsWith(`${base}/`) || base.startsWith(`${path}/`));
}
export function trackedBackupPath(path: string): boolean {
	return included(path) && !(path.startsWith(".loom/") && (path.endsWith("-shm") || path.endsWith(".lock")));
}
function fingerprint(value: FileStamp): FileStamp { return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, ino: value.ino, dev: value.dev }; }

/** On Windows, ctime alone is ambiguous. Callers verify the bytes when they have a content baseline. */
export function sameFileVersion(a: FileStamp, b: FileStamp): boolean {
	return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev
		&& (a.ctimeMs === b.ctimeMs || process.platform === "win32");
}
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
					const after = await lstat(source);
					if (!after.isFile() || !sameFileVersion(stat, after)) throw new Error(`Metadata changed during backup. Retry: ${path}`);
					let hash: string | undefined;
					if (stat.ctimeMs !== after.ctimeMs) {
						const stagedContents = await hashFile(staged, signal, stat.size);
						if (stagedContents.size !== stat.size || !await matchesFileHash(source, after, stagedContents.hash, signal)) {
							throw new Error(`Metadata changed during backup. Retry: ${path}`);
						}
						hash = stagedContents.hash;
					}
					await utimes(staged, stat.atime, stat.mtime);
					const copied = await lstat(staged);
					files.push({ path, source: staged, ...fingerprint(copied), original: fingerprint(after), hash });
				} else files.push({ path, source, ...fingerprint(stat) });
			}
		}
		await walk("");
		return { root, sourceRoot, temporary, libraryId, files, directories };
	} catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

export async function hashFile(file: string, signal: AbortSignal, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<{ hash: string; size: number }> {
	const hash = createHash("sha256"); let size = 0;
	for await (const chunk of createReadStream(file, { signal })) {
		size += chunk.length;
		if (size > maximumBytes) throw new Error(`File changed while reading: ${file}`);
		hash.update(chunk);
	}
	return { hash: hash.digest("hex"), size };
}

export async function matchesFileHash(path: string, expected: FileStamp, hash: string, signal: AbortSignal): Promise<boolean> {
	let before = await lstat(path);
	if (!before.isFile() || !sameFileVersion(expected, before)) return false;
	for (let attempt = 0; attempt < 2; attempt++) {
		const contents = await hashFile(path, signal, expected.size);
		const after = await lstat(path);
		if (!after.isFile() || !sameFileVersion(before, after) || contents.size !== expected.size || contents.hash !== hash) return false;
		if (before.ctimeMs === after.ctimeMs) return true;
		before = after;
	}
	return false;
}

async function recordRead(file: SourceFile, before: FileStamp, contents: { hash: string; size: number }, signal: AbortSignal): Promise<boolean> {
	const after = await lstat(file.source);
	if (!after.isFile() || !sameFileVersion(file, after) || contents.size !== file.size) return false;
	if (file.hash !== undefined && file.hash !== contents.hash) return false;
	// A metadata change during the read is ambiguous. Confirm the hash with a fresh, stable read.
	if (before.ctimeMs !== after.ctimeMs && !await matchesFileHash(file.source, after, contents.hash, signal)) return false;
	file.hash = contents.hash;
	return true;
}

export async function hashSnapshotFile(file: Snapshot["files"][number], signal: AbortSignal): Promise<{ hash: string; size: number }> {
	const before = await lstat(file.source);
	if (!before.isFile() || !sameFileVersion(file, before)) throw new Error(`File changed during preview. Retry: ${file.path}`);
	const result = await hashFile(file.source, signal, file.size);
	if (!await recordRead(file, before, result, signal)) throw new Error(`File changed during preview. Retry: ${file.path}`);
	return result;
}

/** Return a fresh stamp for the live source when it still matches the captured file. */
export async function unchangedSourceStamp(file: SourceFile, source: string, signal: AbortSignal): Promise<FileStamp | undefined> {
	const stat = await lstat(source), expected = file.original ?? file;
	if (!stat.isFile() || !sameFileVersion(expected, stat)) return undefined;
	if (expected.ctimeMs !== stat.ctimeMs && (file.hash === undefined || !await matchesFileHash(source, expected, file.hash, signal))) return undefined;
	return fingerprint(stat);
}

/** Metadata is an immutable capture; check the still-live original files and directory inventory. */
export async function snapshotSourcesUnchanged(snapshot: Snapshot, signal: AbortSignal, includeMetadata = false): Promise<boolean> {
	const files = new Map(snapshot.files.filter((file) => includeMetadata || !file.path.startsWith(".loom/")).map((file) => [file.path, file]));
	const directories = new Set(snapshot.directories.filter((path) => includeMetadata || (path !== ".loom" && !path.startsWith(".loom/"))));
	async function walk(parent: string): Promise<boolean> {
		for (const entry of await readdir(join(snapshot.root, parent), { withFileTypes: true })) {
			signal.throwIfAborted();
			const path = parent ? `${parent}/${entry.name}` : entry.name;
			if ((!includeMetadata && path === ".loom") || !included(path)) continue;
			if (entry.isSymbolicLink()) return false;
			if (entry.isDirectory()) { if (!directories.delete(path) || !await walk(path)) return false; }
			else if (trackedBackupPath(path)) {
				const file = files.get(path);
				if (!file || !await unchangedSourceStamp(file, join(snapshot.root, path), signal)) return false;
				files.delete(path);
			}
		}
		return true;
	}
	try { return await walk("") && files.size === 0 && directories.size === 0; }
	catch { signal.throwIfAborted(); return false; }
}
/** Stage one stable file so the provider uploads exactly the bytes whose hash was calculated. */
export async function stageSnapshotFile(file: Snapshot["files"][number], target: string, signal: AbortSignal): Promise<{ path: string; size: number; mtimeMs: number; hash: string }> {
	signal.throwIfAborted();
	const stat = await lstat(file.source);
	if (!stat.isFile() || !sameFileVersion(file, stat)) throw new Error(`File changed during backup. Retry: ${file.path}`);
	const hash = createHash("sha256"); let size = 0;
	await pipeline(createReadStream(file.source), new Transform({ transform(chunk, _encoding, callback) {
		size += chunk.length;
		if (size > file.size) { callback(new Error(`File changed during backup. Retry: ${file.path}`)); return; }
		hash.update(chunk); callback(null, chunk);
	} }), createWriteStream(target, { mode: 0o600 }), { signal });
	const contents = { size, hash: hash.digest("hex") };
	if (!await recordRead(file, stat, contents, signal)) throw new Error(`File changed during backup. Retry: ${file.path}`);
	return { path: file.path, mtimeMs: file.mtimeMs, ...contents };
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
