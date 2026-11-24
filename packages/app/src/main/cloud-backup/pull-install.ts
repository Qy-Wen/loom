import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { retryWindowsFileOperation } from "@loom/core/fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWrite, readOptionalFile, withFileLock } from "../storage/file.ts";
import type { ObjectStore } from "./object-store.ts";
import { mirrorRoot, readLibrary } from "./mirror.ts";
import { hashFile, matchesFileHash, PERSISTENT_ROOTS, sameFileVersion, snapshotSourcesUnchanged, type FileStamp, type Progress, type Snapshot } from "./snapshot.ts";
import { isMetadata, resolvePull, type PullPlan } from "./pull-plan.ts";

const MARKER = ".loom/backup/pull-install.json";
type Record = { format: 1; root: string; directory: string; transaction: string; libraryId: string; committed: boolean };
export type PullInstallation = { finish(): Promise<void>; rollback(): Promise<void> };
const move = (source: string, target: string) => retryWindowsFileOperation(() => rename(source, target));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function statIfPresent(path: string) {
	try { return await lstat(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
const exists = async (path: string): Promise<boolean> => !!await statIfPresent(path);
async function location(root: string) {
	try { root = await realpath(root); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; root = join(await realpath(dirname(resolve(root))), basename(root)); }
	const key = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 24);
	return { root, prefix: `.loom-pull-${key}-`, journal: join(dirname(root), `.loom-pull-${key}.json`) };
}
async function ownInstallation(root: string, record: Record): Promise<boolean> {
	const text = await readOptionalFile(join(root, MARKER));
	return !!text && JSON.parse(text).transaction === record.transaction;
}
async function cleanup(journal: string, record: Record): Promise<void> {
	await rm(join(dirname(record.root), record.directory), { recursive: true, force: true, maxRetries: 3 });
	await rm(journal, { force: true });
}
/** Recover a two-rename interruption before Core or Chat opens the library. */
export async function recoverPull(root: string): Promise<string | undefined> {
	const loc = await location(root);
	if (!await exists(loc.journal)) return;
	return withFileLock(loc.journal, async () => {
		const text = await readOptionalFile(loc.journal); if (!text) return;
		const record = JSON.parse(text) as Record;
		if (record.format !== 1 || record.root !== loc.root || typeof record.directory !== "string" || !record.directory.startsWith(loc.prefix) || basename(record.directory) !== record.directory || !UUID.test(record.transaction) || !UUID.test(record.libraryId) || typeof record.committed !== "boolean") throw new Error("Invalid pending cloud update; recovery files were retained");
		const directory = join(dirname(loc.root), record.directory), old = join(directory, "old");
		if (!await exists(directory)) {
			if (!await exists(loc.root)) throw new Error("Cloud recovery files are missing");
			if (await ownInstallation(loc.root, record)) {
				if (!record.committed) throw new Error("Original library recovery files are missing");
				await rm(join(loc.root, MARKER), { force: true });
			}
			await rm(loc.journal, { force: true }); return;
		}
		if ((await lstat(directory)).isSymbolicLink()) throw new Error("Cloud recovery directory cannot be a link");
		let saved: string | undefined;
		if (record.committed) {
			if (!await exists(loc.root)) throw new Error("Updated library is missing; recovery files were retained");
			if (await ownInstallation(loc.root, record)) await rm(join(loc.root, MARKER), { force: true });
		} else if (await exists(old)) {
			if ((await lstat(old)).isSymbolicLink()) throw new Error("Cloud recovery library cannot be a link");
			if (JSON.parse(await readFile(join(old, ".loom/backup/identity.json"), "utf8")).id !== record.libraryId) throw new Error("Cloud recovery library identity mismatch");
			if (await exists(loc.root)) {
				if (!await ownInstallation(loc.root, record)) throw new Error("Library path changed; cloud recovery files were retained");
				// Retain the installed tree: another app may have edited it after the crash.
				saved = join(dirname(loc.root), `Loom-pull-recovered-${record.transaction}`);
				await move(loc.root, saved);
			}
			await move(old, loc.root);
		} else if (!await exists(loc.root) || await ownInstallation(loc.root, record)) throw new Error("Original library is missing; recovery files were retained");
		await cleanup(loc.journal, record); return saved;
	});
}

type Stamp = FileStamp & { path: string; directory: boolean };
async function inventory(root: string, signal: AbortSignal, target?: string): Promise<Stamp[]> {
	const stamps: Stamp[] = [];
	async function walk(parent: string) {
		for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
			signal.throwIfAborted();
			const path = parent ? `${parent}/${entry.name}` : entry.name, source = join(root, path), stat = await lstat(source);
			if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Cloud update does not support links or special files: ${path}`);
			stamps.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev, directory: stat.isDirectory() });
			if (stat.isDirectory()) { if (target) await mkdir(join(target, path)); await walk(path); }
			else if (target) {
				// Independent inodes keep rollback databases intact when the new library opens.
				await copyFile(source, join(target, path), constants.COPYFILE_FICLONE);
				await utimes(join(target, path), stat.atime, stat.mtime);
			}
		}
	}
	await walk(""); return stamps.sort((a, b) => a.path.localeCompare(b.path));
}

async function inventoryUnchanged(snapshot: Snapshot, staged: string, stamps: Stamp[], signal: AbortSignal): Promise<boolean> {
	const current = await inventory(snapshot.root, signal);
	if (current.length !== stamps.length) return false;
	const files = new Map(snapshot.files.map((file) => [file.path, file]));
	for (const [index, stamp] of stamps.entries()) {
		const now = current[index]!;
		if (now.path !== stamp.path || now.directory !== stamp.directory || !sameFileVersion(stamp, now)) return false;
		if (stamp.directory || stamp.ctimeMs === now.ctimeMs) continue;
		// Tracked files have a preview hash. For private files, compare with the copy kept for installation.
		let hash = files.get(stamp.path)?.hash;
		if (hash === undefined) {
			const copied = join(staged, stamp.path);
			if (!(await statIfPresent(copied))?.isFile()) return false;
			hash = (await hashFile(copied, signal, stamp.size)).hash;
		}
		if (!await matchesFileHash(join(snapshot.root, stamp.path), stamp, hash, signal)) return false;
	}
	return true;
}

/** The app holds Core and Chat closed until finish/rollback and reopening have completed. */
export async function installPull(snapshot: Snapshot, plan: PullPlan, choices: unknown, store: ObjectStore, signal: AbortSignal, progress: Progress): Promise<PullInstallation | undefined> {
	const selection = resolvePull(plan, choices);
	if (selection.remove.length === 0 && selection.remote.length === 0) {
		const current = await readLibrary(snapshot.libraryId, store, snapshot.temporary, signal);
		if (current?.state !== "ready" || current.revision !== plan.library.revision || current.manifestHash !== plan.library.manifestHash) throw new Error("The cloud library changed during pull. Check again.");
		return;
	}
	const loc = await location(snapshot.root);
	return withFileLock(loc.journal, async (checkLock) => {
		if (await exists(loc.journal)) throw new Error("Recover the pending cloud update before trying again");
		const directory = await mkdtemp(join(dirname(loc.root), loc.prefix)), staged = join(directory, "new");
		const record: Record = { format: 1, root: loc.root, directory: basename(directory), libraryId: snapshot.libraryId, transaction: randomUUID(), committed: false };
		let swapped = false;
		try {
			await atomicWrite(loc.journal, JSON.stringify(record));
			if (!await snapshotSourcesUnchanged(snapshot, signal, true)) throw new Error("Local files changed after the pull preview. Cancel and check again.");
			progress({ phase: "apply", currentFile: undefined }); await mkdir(staged);
			const stamps = await inventory(loc.root, signal, staged);
			for (const node of [...selection.remove].filter((node) => !isMetadata(node.path)).sort((a, b) => b.path.length - a.path.length)) await rm(join(staged, node.path), { recursive: true, force: true });
			if (selection.metadata) for (const path of PERSISTENT_ROOTS) await rm(join(staged, path), { recursive: true, force: true });
			for (const node of selection.remote.filter((node) => node.type === "directory").sort((a, b) => a.path.length - b.path.length)) await mkdir(join(staged, node.path), { recursive: true });
			const downloads = new Set(selection.downloads.map((node) => node.path)), sources = new Map(snapshot.files.map((file) => [file.path, file.source]));
			let completedBytes = 0, completedFiles = 0;
			const totalBytes = selection.downloads.reduce((sum, node) => sum + node.size, 0), files = selection.remote.filter((node) => node.type === "file");
			for (const node of files) {
				signal.throwIfAborted();
				progress({ phase: "download", currentFile: node.path, totalFiles: files.length, totalBytes, completedFiles, completedBytes });
				const target = join(staged, node.path); await mkdir(dirname(target), { recursive: true });
				if (downloads.has(node.path)) await store.download(`${mirrorRoot(snapshot.libraryId)}${node.path}`, target, signal, node.size, (bytes) => progress({ completedBytes: completedBytes + bytes }));
				else await copyFile(sources.get(node.path)!, target, constants.COPYFILE_FICLONE);
				const verified = await hashFile(target, signal, node.size);
				if (verified.hash !== node.hash || verified.size !== node.size) throw new Error(`Cloud file checksum mismatch: ${node.path}`);
				await utimes(target, new Date(), new Date(node.mtimeMs!));
				if (downloads.has(node.path)) completedBytes += node.size;
				completedFiles++; progress({ completedBytes, completedFiles });
			}
			if (JSON.parse(await readFile(join(staged, ".loom/backup/identity.json"), "utf8")).id !== snapshot.libraryId) throw new Error("Cloud library identity mismatch");
			if (selection.metadata) await writeFile(join(staged, ".loom/backup/restore.json"), JSON.stringify({ version: 1, sourceRoot: plan.manifest.sourceRoot, sourceAliases: plan.manifest.sourceAliases }));
			const current = await readLibrary(snapshot.libraryId, store, snapshot.temporary, signal);
			if (current?.state !== "ready" || current.revision !== plan.library.revision || current.manifestHash !== plan.library.manifestHash) throw new Error("The cloud library changed during pull. Check again.");
			if (!await snapshotSourcesUnchanged(snapshot, signal, true) || !await inventoryUnchanged(snapshot, staged, stamps, signal)) throw new Error("Local files changed during pull. Check again.");
			await writeFile(join(staged, MARKER), JSON.stringify({ transaction: record.transaction }));
			signal.throwIfAborted(); checkLock(); progress({ phase: "apply", currentFile: undefined });
			await move(loc.root, join(directory, "old"));
			try { await move(staged, loc.root); swapped = true; }
			catch (error) { await move(join(directory, "old"), loc.root); throw error; }
		} catch (error) {
			// If publication could not be undone, leave the journal for startup recovery.
			if (!swapped && await exists(loc.root) && !await exists(join(directory, "old"))) await cleanup(loc.journal, record);
			throw error;
		}
		return {
			finish: () => withFileLock(loc.journal, async () => {
				await atomicWrite(loc.journal, JSON.stringify({ ...record, committed: true }));
				await rm(join(loc.root, MARKER), { force: true }); await cleanup(loc.journal, record);
			}),
			rollback: async () => { await recoverPull(loc.root); },
		};
	}, { signal });
}
