import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, cp, link, lstat, mkdir, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { retryWindowsFileOperation } from "../fs-retry.ts";
import { copyFilename } from "./names.ts";
import type { LibraryPaths } from "./paths.ts";

export interface PasteConflict {
	sourcePath: string;
	destinationPath: string;
	sourceIsDirectory: boolean;
	destinationIsDirectory: boolean;
}

export type PasteChoice = "replace" | "keep-both" | "cancel";
export type ResolvePasteConflict = (conflict: PasteConflict) => Promise<PasteChoice>;

interface PasteOptions {
	paths: LibraryPaths;
	move: boolean;
	resolveConflict: ResolvePasteConflict;
	checkActive: () => void;
	onPlaced: (source: string, destination: string, directory: boolean, replacedDirectory: boolean) => Promise<void>;
	onMerged: (source: string) => Promise<void>;
}

/** Filesystem paste policy; indexing and user interaction belong to the caller. */
export async function pastePaths(sources: string[], destination: string, options: PasteOptions) {
	const { paths, move, checkActive } = options;
	let cancelled = false;
	const placed: string[] = [];

	async function paste(source: string, parent: string): Promise<string | undefined> {
		checkActive();
		const info = await maybeStat(source);
		if (!info && move) return undefined;
		if (!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || paths.isIgnoredPath(source)) {
			throw new Error(`${basename(source)} cannot be pasted.`);
		}
		const directory = info.isDirectory();
		const actualSource = await realpath(source);
		const actualParent = await realpath(parent);
		if (directory && contains(actualSource, actualParent)) throw new Error("Cannot paste a folder into itself");
		let target = join(parent, basename(source));
		let existing = await maybeStat(target);
		if (await realpath(dirname(source)) === actualParent) {
			if (move) return target;
			target = await availableName(parent, basename(source), directory, true);
			existing = undefined;
		}

		if (directory && existing?.isDirectory()) {
			if (contains(await realpath(target), actualSource)) throw new Error("Cannot merge a folder into its ancestor");
			for (const entry of await readdir(source, { withFileTypes: true })) {
				const child = join(source, entry.name);
				if (entry.isSymbolicLink() || paths.isIgnoredPath(child)) continue;
				await paste(child, target);
				if (cancelled) break;
			}
			if (move && !cancelled) {
				checkActive();
				// Preserve ignored files and any new files that appeared during the paste.
				try {
					await rmdir(source);
					await options.onMerged(source);
				} catch (error) {
					if (!["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				}
			}
			return target;
		}

		if (existing) {
			if (existing.isSymbolicLink()) throw new Error(`Cannot replace a symbolic link: ${target}`);
			const choice = await options.resolveConflict({
				sourcePath: source, destinationPath: target,
				sourceIsDirectory: directory, destinationIsDirectory: existing.isDirectory(),
			});
			checkActive();
			if (choice === "cancel") { cancelled = true; return undefined; }
			if (choice === "keep-both") {
				target = await availableName(parent, basename(source), directory, false);
				existing = undefined;
			} else {
				// Never apply a decision to a different item created while the dialog was open.
				const current = await maybeStat(target);
				if (!current || current.ino !== existing.ino || current.dev !== existing.dev || current.mtimeMs !== existing.mtimeMs) {
					throw new Error(`${basename(target)} changed while waiting for a paste decision. Try again.`);
				}
				// A selected source must never be removed as part of replacing another item.
				if (sources.some((selected) => contains(target, selected))) throw new Error("Cannot replace a selected paste source");
			}
		}

		checkActive();
		await transfer(source, target, directory, existing, options);
		return target;
	}

	for (const source of sources) {
		const target = await paste(source, destination);
		if (target) placed.push(target);
		if (cancelled) break;
	}
	return { placed, cancelled };
}

async function transfer(source: string, destination: string, directory: boolean, previous: Awaited<ReturnType<typeof maybeStat>>, options: PasteOptions): Promise<void> {
	// Finish reading the source before touching the existing destination.
	const staging = join(options.paths.loom, `paste-${randomUUID()}`);
	const staged = join(staging, "incoming");
	const backup = join(staging, "previous");
	await mkdir(staging);
	let backedUp = false;
	let created = false;
	let committed = false;
	let sourceStaged = false;
	try {
		if (options.move) {
			try {
				await retryWindowsFileOperation(() => rename(source, staged));
				sourceStaged = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			}
		}
		if (!sourceStaged) await copyEntry(source, staged, directory);
		options.checkActive();
		if (previous) {
			const current = await maybeStat(destination);
			if (!current || current.ino !== previous.ino || current.dev !== previous.dev || current.mtimeMs !== previous.mtimeMs) {
				throw new Error(`${basename(destination)} changed during paste. Try again.`);
			}
			await retryWindowsFileOperation(() => rename(destination, backup));
			backedUp = true;
		}
		if (directory) {
			await mkdir(destination);
			created = true;
			for (const entry of await readdir(staged)) {
				await moveStagedEntry(join(staged, entry), join(destination, entry));
			}
		} else {
			// Hard links commit files exclusively and preserve identities on same-volume moves.
			try { await link(staged, destination); }
			catch (error) {
				if (!["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				await copyFile(staged, destination, constants.COPYFILE_EXCL);
			}
			created = true;
		}
		committed = true;
		if (options.move && !sourceStaged) await rm(source, { recursive: directory });
		await options.onPlaced(source, destination, directory, backedUp && (await lstat(backup)).isDirectory());
	} catch (error) {
		if (!committed) {
			if (created) {
				if (directory && sourceStaged) {
					for (const entry of await readdir(destination)) {
						if (!(await maybeStat(join(staged, entry)))) await moveStagedEntry(join(destination, entry), join(staged, entry));
					}
				}
				await rm(destination, { recursive: directory, force: true });
			}
			if (sourceStaged) { await rename(staged, source); sourceStaged = false; }
			if (backedUp) { await rename(backup, destination); backedUp = false; }
		}
		throw error;
	} finally {
		// If rollback itself failed, retain the backup for recovery.
		if (committed || (!backedUp && !sourceStaged)) await rm(staging, { recursive: true, force: true });
	}
}

async function copyEntry(source: string, destination: string, directory: boolean): Promise<void> {
	if (directory) await cp(source, destination, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
	else await copyFile(source, destination, constants.COPYFILE_EXCL);
}

async function moveStagedEntry(source: string, destination: string): Promise<void> {
	try { await retryWindowsFileOperation(() => rename(source, destination)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		const info = await lstat(source);
		await copyEntry(source, destination, info.isDirectory());
		await rm(source, { recursive: info.isDirectory() });
	}
}

async function availableName(parent: string, name: string, directory: boolean, copy: boolean): Promise<string> {
	const extension = directory ? "" : extname(name);
	const stem = name.slice(0, name.length - extension.length);
	for (let n = 1; ; n++) {
		const candidate = copy ? copyFilename(stem, extension, n) : `${stem} ${n + 1}${extension}`;
		const path = join(parent, candidate);
		if (!(await maybeStat(path))) return path;
	}
}

async function maybeStat(path: string) {
	try { return await lstat(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function contains(parent: string, child: string): boolean {
	const path = relative(parent, child);
	return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
