import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CloudLibrary } from "../../shared/cloud-backup.ts";
import type { ObjectStore } from "./object-store.ts";
import { hashFile, hashSnapshotFile, stageSnapshotFile, validateBackupPath, validateRelativePath, type Progress, type Snapshot } from "./snapshot.ts";

import { withUploadJournal, type UploadedFile, type UploadJournal } from "./upload-journal.ts";
import { parallelFiles, StagingBudget } from "./upload-pool.ts";

type LibrarySummary = Omit<CloudLibrary, "state" | "manifestHash">;
type MirrorFile = UploadedFile;
export type MirrorManifest = { format: 1; library: LibrarySummary; sourceRoot: string; sourceAliases: string[]; directories: string[]; files: MirrorFile[] };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_JSON = 64 * 1024 * 1024;
const CATALOG = ".loom/libraries/";
const MANIFEST_PATH = ".loom/backup/manifest.json";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function mirrorRoot(libraryId: string): string {
	if (!UUID.test(libraryId)) throw new Error("Invalid cloud library ID");
	return `libraries/${libraryId}/`;
}
export const mirrorManifestKey = (id: string) => `${mirrorRoot(id)}${MANIFEST_PATH}`;
export function libraryCatalogKey(id: string): string { mirrorRoot(id); return `${CATALOG}${id}.json`; }

function parseLibrary(input: unknown): CloudLibrary {
	const r = input as CloudLibrary;
	if (!r || r.format !== 1 || !UUID.test(r.libraryId) || !UUID.test(r.revision) || typeof r.libraryName !== "string" || typeof r.deviceName !== "string" || typeof r.updatedAt !== "string" || !Number.isFinite(Date.parse(r.updatedAt)) || !Number.isSafeInteger(r.fileCount) || r.fileCount < 0 || !Number.isSafeInteger(r.totalBytes) || r.totalBytes < 0 || !["ready", "updating"].includes(r.state) || (r.state === "ready" && !HASH.test(r.manifestHash ?? ""))) throw new Error("Invalid cloud library metadata");
	return r;
}
async function readJson(store: ObjectStore, key: string, directory: string, signal: AbortSignal, limit = MAX_JSON): Promise<{ value: unknown; hash: string }> {
	const path = join(directory, randomUUID());
	try {
		await store.download(key, path, signal, limit);
		const bytes = await readFile(path);
		if (bytes.length > limit) throw new Error("Cloud metadata is too large");
		return { value: JSON.parse(bytes.toString("utf8")), hash: sha256(bytes) };
	} finally { await rm(path, { force: true }); }
}
export async function readLibrary(id: string, store: ObjectStore, temporary: string, signal: AbortSignal): Promise<CloudLibrary | undefined> {
	const key = libraryCatalogKey(id);
	if (!await store.head(key, signal)) return undefined;
	const library = parseLibrary((await readJson(store, key, temporary, signal, 16 * 1024)).value);
	if (library.libraryId !== id) throw new Error("Cloud library ID does not match its key");
	return library;
}
function validateManifest(input: unknown, library: CloudLibrary): MirrorManifest {
	const m = input as MirrorManifest;
	if (!m || m.format !== 1 || !m.library || m.library.libraryId !== library.libraryId || m.library.revision !== library.revision || typeof m.sourceRoot !== "string" || !Array.isArray(m.sourceAliases) || m.sourceAliases.length > 20 || m.sourceAliases.some((p) => typeof p !== "string") || !Array.isArray(m.files) || !Array.isArray(m.directories) || m.files.length !== library.fileCount) throw new Error("Invalid cloud library manifest");
	const paths = new Map<string, "file" | "directory">();
	for (const [path, kind] of [...m.directories.map((p) => [p, "directory"] as const), ...m.files.map((f) => [f.path, "file"] as const)]) {
		validateBackupPath(path);
		const key = path.normalize("NFC").toLowerCase();
		if (paths.has(key)) throw new Error("Duplicate or case-conflicting paths in cloud library");
		paths.set(key, kind);
	}
	let bytes = 0;
	for (const file of m.files) {
		if (!HASH.test(file.hash) || typeof file.etag !== "string" || !file.etag || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isFinite(file.mtimeMs) || Math.abs(file.mtimeMs) > 8.64e15) throw new Error("Invalid cloud file entry");
		bytes += file.size;
	}
	for (const path of [...m.directories, ...m.files.map((f) => f.path)]) {
		const parts = path.split("/"); parts.pop();
		while (parts.length) { if (paths.get(parts.join("/").normalize("NFC").toLowerCase()) !== "directory") throw new Error("Missing parent directory in cloud library"); parts.pop(); }
	}
	if (bytes !== library.totalBytes) throw new Error("Cloud library size does not match metadata");
	return m;
}
export async function readManifest(library: CloudLibrary, store: ObjectStore, temporary: string, signal: AbortSignal): Promise<MirrorManifest> {
	const json = await readJson(store, mirrorManifestKey(library.libraryId), temporary, signal);
	if (json.hash !== library.manifestHash) throw new Error("Cloud manifest checksum mismatch");
	return validateManifest(json.value, library);
}
async function writeJson(store: ObjectStore, key: string, value: unknown, temporary: string, signal: AbortSignal): Promise<string> {
	const bytes = Buffer.from(JSON.stringify(value));
	if (bytes.length > MAX_JSON) throw new Error("Cloud manifest is too large");
	const path = join(temporary, randomUUID());
	try { await writeFile(path, bytes); await store.upload(key, path, signal); return sha256(bytes); }
	finally { await rm(path, { force: true }); }
}
async function assertCurrent(library: CloudLibrary, store: ObjectStore, temporary: string, signal: AbortSignal): Promise<void> {
	const current = await readLibrary(library.libraryId, store, temporary, signal);
	if (!current || current.revision !== library.revision || current.state !== library.state) throw new Error("The cloud library changed on another device. Refresh and retry.");
}

class FileTransferError extends Error {
	readonly path: string;
	constructor(path: string, error: unknown) { super(`${path}: ${error instanceof Error ? error.message : "Cloud transfer failed"}`); this.path = path; }
}

export type MirrorUpdateOptions = { resumeFile?: string; concurrency?: number };

/** One mutable copy per library. An incomplete update is explicitly unavailable for restore. */
export async function updateMirror(snapshot: Snapshot, store: ObjectStore, deviceName: string, signal: AbortSignal, progress: Progress, changed: (library: CloudLibrary) => void = () => {}, completed: (manifest: MirrorManifest) => void = () => {}, options: MirrorUpdateOptions = {}): Promise<CloudLibrary> {
	try {
		const concurrency = options.concurrency ?? 3;
		if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Backup concurrency must be between 1 and 4");
		const run = (journal?: UploadJournal) => performUpdate(snapshot, store, deviceName, signal, progress, changed, completed, concurrency, journal);
		return options.resumeFile ? await withUploadJournal(options.resumeFile, snapshot.libraryId, signal, run) : await run();
	} finally { await rm(snapshot.temporary, { recursive: true, force: true, maxRetries: 3 }); }
}

async function performUpdate(snapshot: Snapshot, store: ObjectStore, deviceName: string, signal: AbortSignal, progress: Progress, changed: (library: CloudLibrary) => void, completed: (manifest: MirrorManifest) => void, concurrency: number, journal?: UploadJournal): Promise<CloudLibrary> {
	const base = mirrorRoot(snapshot.libraryId);
	const totalBytes = snapshot.files.reduce((sum, file) => sum + file.size, 0);
	const summary: LibrarySummary = { format: 1, libraryId: snapshot.libraryId, libraryName: basename(snapshot.root), revision: randomUUID(), updatedAt: new Date().toISOString(), deviceName, fileCount: snapshot.files.length, totalBytes };
	const updating: CloudLibrary = { ...summary, state: "updating" };
	const previous = await readLibrary(snapshot.libraryId, store, snapshot.temporary, signal);
	let oldManifest: MirrorManifest | undefined;
	if (previous?.state === "ready") {
		try { oldManifest = await readManifest(previous, store, snapshot.temporary, signal); }
		catch { signal.throwIfAborted(); /* Rebuild a missing/damaged manifest from the authoritative local copy. */ }
	}
	// Incomplete remote manifests cannot establish integrity. Locally verified progress is tied to that exact revision.
	const resumed = previous?.state === "updating" && journal ? await journal.read(previous.revision) : [];
	const wantedPaths = new Set(snapshot.files.map((file) => file.path));
	const oldFiles = new Map([...(oldManifest?.files ?? []), ...resumed].filter((file) => wantedPaths.has(file.path)).map((file) => [file.path, file]));
	await journal?.begin(updating.revision, oldFiles.values());
	signal.throwIfAborted(); journal?.check();
	await writeJson(store, libraryCatalogKey(snapshot.libraryId), updating, snapshot.temporary, signal);
	changed(updating);
	const files = new Array<MirrorFile>(snapshot.files.length), budget = new StagingBudget(64 * 1024 * 1024);
	const inFlight = new Map<number, number>();
	let completedBytes = 0, completedFiles = 0, uploadedBytes = 0, skippedFiles = 0;
	const report = (currentFile?: string) => {
		const sending = [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
		progress({ phase: "upload", totalBytes, totalFiles: snapshot.files.length, completedFiles, completedBytes: completedBytes + sending, uploadedBytes: uploadedBytes + sending, skippedFiles, currentFile });
	};
	await parallelFiles(snapshot.files, concurrency, signal, async (file, index, worker, transfer) => {
		try {
			journal?.check(); report(file.path);
			const key = `${base}${file.path}`, old = oldFiles.get(file.path), immutable = file.path.startsWith(".loom/");
			let staged: string | undefined, release: (() => void) | undefined;
			let uploaded = false;
			try {
				// Attributes choose the cheaper read path; they never replace content verification.
				// Likely edits are hashed while staging, avoiding a second source read for large changed files.
				const stageFirst = !immutable && (!old || old.size !== file.size || Math.abs(old.mtimeMs - file.mtimeMs) >= 1);
				if (stageFirst) { release = await budget.acquire(file.size, transfer); staged = join(snapshot.temporary, `upload-${worker}`); }
				let contents = staged ? await stageSnapshotFile(file, staged, transfer) : await hashSnapshotFile(file, transfer);
				let info = old?.hash === contents.hash ? await store.head(key, transfer) : undefined;
				if (!info || info.size !== file.size || info.etag !== old?.etag) {
					if (!immutable && !staged) {
						release = await budget.acquire(file.size, transfer);
						staged = join(snapshot.temporary, `upload-${worker}`);
						contents = await stageSnapshotFile(file, staged, transfer);
					}
					journal?.check();
					let tracking = true;
					try {
						await store.upload(key, staged ?? file.source, transfer, (bytes) => {
							if (!tracking) return;
							inFlight.set(index, Math.max(inFlight.get(index) ?? 0, Math.min(file.size, Math.max(0, bytes)))); report(file.path);
						});
					} finally { tracking = false; }
					uploaded = true;
					info = await store.head(key, transfer);
				}
				if (!contents || !info || info.size !== file.size) throw new Error(`Cloud file verification failed: ${file.path}`);
				const entry: MirrorFile = { path: file.path, size: file.size, mtimeMs: file.mtimeMs, hash: contents.hash, etag: info.etag };
				await journal?.record(entry);
				files[index] = entry; inFlight.delete(index);
				if (uploaded) uploadedBytes += file.size; else skippedFiles++;
				completedBytes += file.size; completedFiles++; report(file.path);
			} finally {
				try { if (staged) await rm(staged, { force: true, maxRetries: 3 }); }
				finally { release?.(); }
			}
		} catch (error) { throw new FileTransferError(file.path, error); }
	}).catch((error) => { if (error instanceof FileTransferError) progress({ currentFile: error.path }); throw error; });
	const empty = join(snapshot.temporary, "empty"); await writeFile(empty, "");
	// Independent HEAD/PUT requests overlap, while large file staging stays within the shared byte budget.
	await parallelFiles(snapshot.directories, concurrency, signal, async (path, _index, _worker, transfer) => {
		journal?.check();
		const key = `${base}${path}/`, info = await store.head(key, transfer);
		if (!info || info.size !== 0) await store.upload(key, empty, transfer);
	});
	journal?.check();
	await assertCurrent(updating, store, snapshot.temporary, signal);
	const manifest: MirrorManifest = { format: 1, library: summary, sourceRoot: snapshot.root, sourceAliases: [snapshot.sourceRoot], directories: snapshot.directories, files };
	const manifestHash = await writeJson(store, mirrorManifestKey(snapshot.libraryId), manifest, snapshot.temporary, signal);
	await assertCurrent(updating, store, snapshot.temporary, signal);
	const wanted = new Set([base, mirrorManifestKey(snapshot.libraryId), ...files.map((file) => `${base}${file.path}`), ...snapshot.directories.map((path) => `${base}${path}/`)]);
	progress({ phase: "delete", currentFile: undefined });
	// All workers have settled successfully before deletion can start.
	for await (const key of store.list(base, signal)) {
		signal.throwIfAborted(); journal?.check();
		if (!key.startsWith(base)) throw new Error("Refusing to delete outside the current cloud library");
		if (!wanted.has(key)) {
			const path = key.slice(base.length);
			validateRelativePath(path.replace(/\/$/, ""), false);
			progress({ currentFile: path }); await store.remove(key, signal);
		}
	}
	journal?.check();
	await assertCurrent(updating, store, snapshot.temporary, signal);
	const ready: CloudLibrary = { ...summary, state: "ready", manifestHash };
	await writeJson(store, libraryCatalogKey(snapshot.libraryId), ready, snapshot.temporary, signal);
	changed(ready); completed(manifest);
	await journal?.clear();
	return ready;
}

/** A completed cloud manifest is a comparison baseline, never an upload history. */
export async function readMirrorReference(snapshot: Snapshot, store: ObjectStore, signal: AbortSignal): Promise<{ library?: CloudLibrary; manifest?: MirrorManifest }> {
	const library = await readLibrary(snapshot.libraryId, store, snapshot.temporary, signal);
	if (!library || library.state !== "ready") return { library };
	try { return { library, manifest: await readManifest(library, store, snapshot.temporary, signal) }; }
	catch { signal.throwIfAborted(); return { library }; }
}

export async function assertMirrorReference(snapshot: Snapshot, library: CloudLibrary | undefined, store: ObjectStore, signal: AbortSignal): Promise<void> {
	const current = await readLibrary(snapshot.libraryId, store, snapshot.temporary, signal);
	if (current?.revision !== library?.revision || current?.state !== library?.state) throw new Error("The cloud library changed during preview. Refresh and retry.");
}

export async function listCloudLibraries(store: ObjectStore, signal: AbortSignal): Promise<CloudLibrary[]> {
	const temporary = await mkdtemp(join(tmpdir(), "loom-cloud-list-"));
	try {
		const libraries: CloudLibrary[] = [];
		for await (const key of store.list(CATALOG, signal)) {
			if (key === CATALOG) continue;
			const library = parseLibrary((await readJson(store, key, temporary, signal, 16 * 1024)).value);
			if (key !== libraryCatalogKey(library.libraryId)) throw new Error("Cloud library metadata key does not match its content");
			libraries.push(library);
		}
		return libraries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Verify a complete current copy, and publish only a new local directory. */
export async function restoreMirror(libraryId: string, parent: string, store: ObjectStore, signal: AbortSignal, progress: Progress, completed: (manifest: MirrorManifest) => void = () => {}): Promise<string> {
	const temporary = await mkdtemp(join(await realpath(parent), ".loom-restore-"));
	try {
		const library = await readLibrary(libraryId, store, temporary, signal);
		if (!library || library.state !== "ready") throw new Error("Cloud copy is incomplete. Update it from the source library before restoring.");
		const manifest = await readManifest(library, store, temporary, signal);
		const output = join(temporary, "library"); await mkdir(output);
		for (const path of [...manifest.directories].sort((a, b) => a.split("/").length - b.split("/").length)) { signal.throwIfAborted(); await mkdir(join(output, path)); }
		let completedBytes = 0, completedFiles = 0;
		for (const file of manifest.files) {
			signal.throwIfAborted();
			progress({ phase: "download", completedBytes, completedFiles, totalBytes: library.totalBytes, totalFiles: library.fileCount, currentFile: file.path });
			const target = join(output, file.path);
			const reserved = await open(target, "wx", 0o600); await reserved.close();
			await store.download(`${mirrorRoot(libraryId)}${file.path}`, target, signal, file.size, (bytes) => progress({ completedBytes: completedBytes + bytes }));
			progress({ phase: "verify" });
			const check = await hashFile(target, signal);
			if (check.hash !== file.hash || check.size !== file.size) throw new Error(`Cloud file checksum mismatch: ${file.path}`);
			await utimes(target, new Date(), new Date(file.mtimeMs));
			completedBytes += file.size; completedFiles++; progress({ completedBytes, completedFiles });
		}
		await assertCurrent(library, store, temporary, signal);
		const marker = join(output, ".loom/backup/restore.json"); await mkdir(dirname(marker), { recursive: true });
		await writeFile(marker, JSON.stringify({ version: 1, sourceRoot: manifest.sourceRoot, sourceAliases: manifest.sourceAliases }));
		signal.throwIfAborted();
		const container = await mkdtemp(join(parent, "Loom-restored-")), destination = join(container, "Library");
		try { await rename(output, destination); }
		catch (error) { await rm(container, { recursive: true, force: true }); throw error; }
		completed(manifest); return destination;
	} finally { await rm(temporary, { recursive: true, force: true, maxRetries: 3 }); }
}
