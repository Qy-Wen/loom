import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	assetTypeFromPath,
	type Asset,
	type LibraryChange,
	type LibrarySnapshot,
} from "../model/asset.ts";
import { statAssetFile, statVolumeId } from "./file-identity.ts";
import { diffLibraryAssets, LibraryHandlers } from "./handlers.ts";
import {
	assertEntryName,
	COMPOSER_INBOX_FOLDER,
	copyFilename,
	joinRelative,
	parentRelative,
	posixBasename,
	rewriteRelativePrefix,
	wouldNestInside,
} from "./names.ts";
import { LibraryPaths } from "./paths.ts";
import { reconcileOpenAssets, type ReconcileDiskFile } from "./reconcile.ts";
import { releaseProcessSandbox, setProcessSandboxRoot } from "../sandbox/process-sandbox.ts";
import { LibraryWatcher, type LibraryFileEvent } from "./watcher.ts";

type LibraryListener = (change: LibraryChange) => void;

export interface PlacedLibraryItems {
	assets: Asset[];
	folders: string[];
}

type PlacedEntry =
	| { kind: "asset"; asset: Asset }
	| { kind: "folder"; relativePath: string };

const REMOVE_GRACE_MS = 500;

/**
 * Reconciles the filesystem (source of truth) with LibraryHandlers and emits
 * incremental changes for the UI. Watcher events are serialized through one
 * queue so add/remove races cannot mutate the store concurrently.
 */
export class Library {
	private paths: LibraryPaths | null = null;
	private watcher: LibraryWatcher | null = null;
	private readonly folders = new Set<string>();
	private readonly listeners = new Set<LibraryListener>();
	private updateQueue: Promise<void> = Promise.resolve();
	private liveReconcileTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly handlers: LibraryHandlers;

	constructor(handlers: LibraryHandlers) {
		this.handlers = handlers;
	}

	private get metadata() {
		return this.handlers.metadata;
	}

	async open(rootPath: string): Promise<LibrarySnapshot> {
		await this.stopWatching();
		await this.metadata.close();

		const info = await stat(rootPath);
		if (!info.isDirectory()) throw new Error(`Not a directory: ${rootPath}`);

		this.paths = new LibraryPaths(rootPath);
		this.folders.clear();
		const opened = this.paths.root;
		setProcessSandboxRoot(opened);
		try {
			await mkdir(join(opened, ".agents", "memory"), { recursive: true });
			await this.metadata.open(this.paths);
			await this.metadata.recoverInterruptedJobs();
			await this.syncFromDisk(false);

			const watcher = new LibraryWatcher(this.paths);
			this.watcher = watcher;
			await watcher.start((event) => this.enqueueFileEvent(event));

			const snapshot = await this.getSnapshot();
			this.emit({ type: "reset", snapshot });
			return snapshot;
		} catch (error) {
			await releaseProcessSandbox(opened);
			throw error;
		}
	}

	async getSnapshot(): Promise<LibrarySnapshot> {
		if (!this.paths) return { rootPath: null, folders: [], assets: [], favoriteAssetIds: [], tags: [], assetTags: [] };
		return {
			rootPath: this.paths.root,
			folders: [...this.folders].sort((a, b) => a.localeCompare(b)),
			assets: await this.metadata.listAssets(),
			favoriteAssetIds: await this.metadata.listFavoriteIds(),
			tags: await this.metadata.listTags(),
			assetTags: await this.metadata.listAssetTags(),
		};
	}

	async setFavorite(assetId: string, favorite: boolean): Promise<void> {
		if (!this.paths) throw new Error("Open a library first.");
		await this.metadata.setFavorite(assetId, favorite);
		this.emit({ type: "favorites", assetIds: await this.metadata.listFavoriteIds() });
	}

	async addAssetTag(assetId: string, name: string): Promise<void> {
		if (!this.paths) throw new Error("Open a library first.");
		await this.metadata.addAssetTag(assetId, name);
		this.emit({
			type: "tags",
			tags: await this.metadata.listTags(),
			assetTags: await this.metadata.listAssetTags(),
		});
	}

	async removeAssetTag(assetId: string, tagId: string): Promise<void> {
		if (!this.paths) throw new Error("Open a library first.");
		await this.metadata.removeAssetTag(assetId, tagId);
		this.emit({
			type: "tags",
			tags: await this.metadata.listTags(),
			assetTags: await this.metadata.listAssetTags(),
		});
	}

	subscribe(listener: LibraryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getAssetFilePath(assetId: string): Promise<string | undefined> {
		if (!this.paths) return undefined;
		const asset = await this.metadata.getAsset(assetId);
		return asset ? this.paths.toAbsolutePath(asset.relativePath) : undefined;
	}

	async renameAsset(assetId: string, requestedStem: string): Promise<Asset> {
		const asset = await this.requireAsset(assetId);
		const stem = requestedStem.trim();
		if (!stem || stem === "." || stem === ".." || /[\\/\0]/.test(stem)) {
			throw new Error("Enter a valid file name");
		}

		const extension = extname(asset.filename);
		const filename = `${stem}${extension}`;
		if (filename === asset.filename) return asset;
		const parent = parentRelative(asset.relativePath);
		return this.relocateAsset(asset, joinRelative(parent, filename));
	}

	async duplicateAsset(assetId: string): Promise<Asset> {
		const source = await this.requireAsset(assetId);
		return this.copyAssetInto(assetId, parentRelative(source.relativePath));
	}

	async copyAssetInto(assetId: string, destFolder: string): Promise<Asset> {
		const paths = this.requirePaths();
		const source = await this.requireAsset(assetId);
		await this.requireDirectory(destFolder);
		const sourcePath = paths.toAbsolutePath(source.relativePath);
		const filename = await this.uniqueCopyName(destFolder, source.filename);
		const relativePath = joinRelative(destFolder, filename);
		const destinationPath = paths.toAbsolutePath(relativePath);

		const reserved: Asset = {
			...source,
			assetId: randomUUID(),
			filename,
			relativePath,
			createdAt: Date.now(),
			modifiedAt: Date.now(),
		};
		await this.handlers.upsertAsset(reserved);
		try {
			await copyFile(sourcePath, destinationPath);
		} catch (error) {
			await this.handlers.removeAsset(reserved);
			throw error;
		}

		const info = await statAssetFile(destinationPath);
		const duplicate: Asset = {
			...reserved,
			size: info.size,
			createdAt: info.createdAt,
			modifiedAt: info.modifiedAt,
			fileSystemId: info.fileSystemId,
		};
		await this.handlers.upsertAsset(duplicate);
		this.emit({ type: "upsert", asset: duplicate });
		return duplicate;
	}

	async copyAssetsInto(assetIds: string[], destFolder: string): Promise<Asset[]> {
		const copied: Asset[] = [];
		for (const assetId of assetIds) copied.push(await this.copyAssetInto(assetId, destFolder));
		return copied;
	}

	async moveAssetInto(assetId: string, destFolder: string): Promise<Asset> {
		const source = await this.requireAsset(assetId);
		await this.requireDirectory(destFolder);
		if (parentRelative(source.relativePath) === destFolder) return source;
		const extension = extname(source.filename);
		const filename = await this.uniqueFilename(destFolder, basename(source.filename, extension), extension);
		return this.relocateAsset(source, joinRelative(destFolder, filename));
	}

	async moveAssetsInto(assetIds: string[], destFolder: string): Promise<Asset[]> {
		const moved: Asset[] = [];
		for (const assetId of assetIds) moved.push(await this.moveAssetInto(assetId, destFolder));
		return moved;
	}

	async createFolder(parentRelativePath: string, requestedName?: string): Promise<string> {
		await this.requireDirectory(parentRelativePath);
		const name = requestedName
			? assertEntryName(requestedName)
			: await this.uniqueName(parentRelativePath, "New Folder");
		if (requestedName && await this.pathExists(joinRelative(parentRelativePath, name))) {
			throw new Error(`A folder named “${name}” already exists`);
		}
		const relativePath = joinRelative(parentRelativePath, name);
		await mkdir(this.folderAbsolute(relativePath));
		this.trackFolder(relativePath);
		return relativePath;
	}

	async createMarkdownFile(parentRelativePath: string): Promise<Asset> {
		await this.requireDirectory(parentRelativePath);
		const filename = await this.uniqueFilename(parentRelativePath, "Untitled", ".md");
		const relativePath = joinRelative(parentRelativePath, filename);
		await writeFile(this.folderAbsolute(relativePath), "");
		const asset = await this.indexFile(relativePath);
		if (!asset) throw new Error("Failed to create markdown file");
		return asset;
	}

	async renameFolder(relativePath: string, requestedName: string): Promise<string> {
		if (!relativePath) throw new Error("Cannot rename the library root");
		const name = assertEntryName(requestedName);
		const parent = parentRelative(relativePath);
		const nextPath = joinRelative(parent, name);
		if (nextPath === relativePath) return relativePath;
		if (await this.pathExists(nextPath)) {
			throw new Error(`A folder named “${name}” already exists`);
		}

		const watching = await this.pauseWatcher();
		try {
			await renameRetry(this.folderAbsolute(relativePath), this.folderAbsolute(nextPath));
			await this.rewriteFolderPrefix(relativePath, nextPath);
			return nextPath;
		} finally {
			if (watching) await this.resumeWatcher();
		}
	}

	/**
	 * Copy files from outside the library into `Inbox/`, or reuse a file already in the library.
	 * Does not run VLM or embeddings.
	 */
	async importExternalFiles(absolutePaths: string[]): Promise<Asset[]> {
		const paths = this.requirePaths();
		await this.ensureInbox();
		const imported: Asset[] = [];
		const seen = new Set<string>();
		for (const raw of absolutePaths) {
			const absolutePath = resolve(raw);
			let info: Awaited<ReturnType<typeof stat>>;
			try {
				info = await stat(absolutePath);
			} catch {
				throw new Error(`${basename(absolutePath)} could not be read.`);
			}
			if (!info.isFile()) throw new Error(`${basename(absolutePath)} is not a file.`);
			if (paths.isIgnoredPath(absolutePath)) throw new Error(`${basename(absolutePath)} cannot be imported.`);

			try {
				const relativePath = paths.toRelativePath(absolutePath);
				const existing = await this.indexFile(relativePath);
				if (existing) {
					if (!seen.has(existing.assetId)) {
						seen.add(existing.assetId);
						imported.push(existing);
					}
					continue;
				}
			} catch {
				// Outside the library: copy into Inbox.
			}

			const extension = extname(absolutePath);
			const stem = assertEntryName(basename(absolutePath, extension) || "file");
			const filename = await this.uniqueFilename(COMPOSER_INBOX_FOLDER, stem, extension);
			const destRelative = joinRelative(COMPOSER_INBOX_FOLDER, filename);
			await copyFile(absolutePath, paths.toAbsolutePath(destRelative));
			const asset = await this.indexFile(destRelative);
			if (!asset) throw new Error(`Failed to import ${basename(absolutePath)}`);
			if (seen.has(asset.assetId)) continue;
			seen.add(asset.assetId);
			imported.push(asset);
		}
		return imported;
	}

	/**
	 * Copy or move absolute paths into a library folder.
	 * Paths already in the library keep their asset ids when moved.
	 * A move deletes an outside source only after that source is in the library.
	 */
	async placePathsInto(absolutePaths: string[], destFolder: string, move: boolean): Promise<PlacedLibraryItems> {
		await this.requireDirectory(destFolder);
		const selected = rootAbsolutePaths(absolutePaths);
		if (selected.length === 0) return { assets: [], folders: [] };

		const watching = await this.pauseWatcher();
		try {
			const assets: Asset[] = [];
			const folders: string[] = [];
			for (const absolutePath of selected) {
				const placed = await this.placeOnePath(absolutePath, destFolder, move);
				if (!placed) continue;
				if (placed.kind === "asset") assets.push(placed.asset);
				else folders.push(placed.relativePath);
			}
			return { assets, folders };
		} finally {
			if (watching) await this.resumeWatcher();
		}
	}

	async copyFolderInto(sourceFolder: string, destFolder: string): Promise<string> {
		if (!sourceFolder) throw new Error("Cannot copy the library root");
		await this.requireDirectory(sourceFolder);
		await this.requireDirectory(destFolder);
		if (wouldNestInside(sourceFolder, destFolder)) {
			throw new Error("Cannot paste a folder into itself");
		}

		const desired = posixBasename(sourceFolder);
		const name = await this.pathExists(joinRelative(destFolder, desired))
			? await this.uniqueName(destFolder, `${desired} copy`)
			: desired;
		const destRelative = joinRelative(destFolder, name);
		await cp(this.folderAbsolute(sourceFolder), this.folderAbsolute(destRelative), { recursive: true });
		await this.indexTree(destRelative);
		return destRelative;
	}

	async moveFolderInto(sourceFolder: string, destFolder: string): Promise<string> {
		if (!sourceFolder) throw new Error("Cannot move the library root");
		await this.requireDirectory(sourceFolder);
		await this.requireDirectory(destFolder);
		if (wouldNestInside(sourceFolder, destFolder)) {
			throw new Error("Cannot move a folder into itself");
		}
		if (parentRelative(sourceFolder) === destFolder) return sourceFolder;

		const desired = posixBasename(sourceFolder);
		const name = await this.pathExists(joinRelative(destFolder, desired))
			? await this.uniqueName(destFolder, desired)
			: desired;
		const nextPath = joinRelative(destFolder, name);
		const watching = await this.pauseWatcher();
		try {
			await renameRetry(this.folderAbsolute(sourceFolder), this.folderAbsolute(nextPath));
			await this.rewriteFolderPrefix(sourceFolder, nextPath);
			return nextPath;
		} finally {
			if (watching) await this.resumeWatcher();
		}
	}

	getFolderFilePath(relativePath: string): string {
		return this.folderAbsolute(relativePath);
	}

	async forgetFolder(relativePath: string): Promise<void> {
		if (!relativePath) return;
		const prefix = `${relativePath}/`;
		const assets = (await this.metadata.listAssets()).filter(
			(asset) => asset.relativePath.startsWith(prefix),
		);
		for (const asset of assets) await this.commitRemoval(asset, true);
		this.folders.delete(relativePath);
		for (const folder of [...this.folders]) {
			if (folder.startsWith(prefix)) this.folders.delete(folder);
		}
		this.emit({ type: "folder_remove", relativePath });
	}

	async forgetAsset(assetId: string): Promise<void> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) return;
		await this.commitRemoval(asset, true);
	}

	/** Index a file that already exists on disk so its UUID is available immediately. */
	async indexFile(relativePath: string): Promise<Asset | undefined> {
		const paths = this.requirePaths();
		let absolutePath: string;
		try {
			absolutePath = paths.toAbsolutePath(relativePath);
		} catch {
			return undefined;
		}
		if (paths.isIgnoredPath(absolutePath)) return undefined;

		let info: Awaited<ReturnType<typeof statAssetFile>>;
		try {
			info = await statAssetFile(absolutePath);
		} catch {
			return undefined;
		}
		if (!info.isFile) return undefined;

		const existing = await this.metadata.getAssetByPath(relativePath)
			?? (info.fileSystemId ? await this.metadata.getAssetByFileSystemId(info.fileSystemId) : undefined);
		const asset: Asset = {
			assetId: existing?.assetId ?? randomUUID(),
			relativePath,
			filename: basename(relativePath),
			type: assetTypeFromPath(relativePath),
			size: info.size,
			createdAt: existing?.createdAt ?? info.createdAt,
			modifiedAt: info.modifiedAt,
			fileSystemId: info.fileSystemId,
		};
		await this.handlers.upsertAsset(asset);
		for (const folder of ancestorFolders(relativePath)) {
			if (this.folders.has(folder)) continue;
			this.folders.add(folder);
			this.emit({ type: "folder_upsert", relativePath: folder });
		}
		this.emit({ type: "upsert", asset });
		return asset;
	}

	async close(): Promise<void> {
		const opened = this.paths?.root;
		await this.stopWatching();
		await this.updateQueue;
		this.paths = null;
		this.folders.clear();
		await this.metadata.close();
		if (opened) {
			await releaseProcessSandbox(opened);
			this.emit({ type: "reset", snapshot: await this.getSnapshot() });
		}
	}

	async stopWatching(): Promise<void> {
		await this.pauseWatcher();
	}

	private async pauseWatcher(): Promise<boolean> {
		const watcher = this.watcher;
		this.watcher = null;
		if (this.liveReconcileTimer) {
			clearTimeout(this.liveReconcileTimer);
			this.liveReconcileTimer = null;
		}
		if (watcher) await watcher.close();
		await this.updateQueue;
		return watcher !== null;
	}

	private async resumeWatcher(): Promise<void> {
		if (this.watcher || !this.paths) return;
		const watcher = new LibraryWatcher(this.paths);
		this.watcher = watcher;
		await watcher.start((event) => this.enqueueFileEvent(event));
	}

	private async volumeWasRelocated(currentVolumeId: string): Promise<boolean> {
		const storedVolumeId = await this.metadata.getLibraryVolumeId();
		return storedVolumeId !== undefined && storedVolumeId !== currentVolumeId;
	}

	private async collectLibraryFiles(directory: string, files: ReconcileDiskFile[]): Promise<void> {
		const paths = this.requirePaths();
		const entries = await readdir(directory, { withFileTypes: true });

		for (const entry of entries) {
			const absolutePath = join(directory, entry.name);
			if (paths.isIgnoredPath(absolutePath) || entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				this.folders.add(paths.toRelativePath(absolutePath));
				await this.collectLibraryFiles(absolutePath, files);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const info = await statAssetFile(absolutePath);
				if (!info.isFile) continue;
				files.push({
					relativePath: paths.toRelativePath(absolutePath),
					filename: entry.name,
					fileSystemId: info.fileSystemId,
					size: info.size,
					createdAt: info.createdAt,
					modifiedAt: info.modifiedAt,
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw error;
			}
		}
	}

	private enqueueFileEvent(event: LibraryFileEvent): void {
		if (event.type === "error") {
			this.emit({ type: "error", message: event.error.message });
			return;
		}
		// Wait for the burst to settle, then reuse the same full-disk match as open.
		if (this.liveReconcileTimer) clearTimeout(this.liveReconcileTimer);
		this.liveReconcileTimer = setTimeout(() => {
			this.liveReconcileTimer = null;
			this.updateQueue = this.updateQueue
				.then(() => this.syncFromDisk(true))
				.catch((error) => {
					this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
				});
		}, REMOVE_GRACE_MS);
	}

	private async syncFromDisk(notify: boolean): Promise<void> {
		const paths = this.requirePaths();
		const previousFolders = new Set(this.folders);
		this.folders.clear();
		const diskFiles: ReconcileDiskFile[] = [];
		await this.collectLibraryFiles(paths.root, diskFiles);
		const currentVolumeId = await statVolumeId(paths.root);
		const trustPath = await this.volumeWasRelocated(currentVolumeId);
		const previous = await this.metadata.listAssets();
		const next = reconcileOpenAssets(previous, diskFiles, trustPath);
		await this.handlers.applyOpenReconcile(previous, next);
		await this.metadata.setLibraryVolumeId(currentVolumeId);
		if (!notify) return;

		for (const situation of diffLibraryAssets(previous, next)) {
			if (situation.type === "removed") this.emit({ type: "remove", assetId: situation.asset.assetId });
			else this.emit({ type: "upsert", asset: situation.asset });
		}
		for (const folder of previousFolders) {
			if (!this.folders.has(folder)) this.emit({ type: "folder_remove", relativePath: folder });
		}
		for (const folder of this.folders) {
			if (!previousFolders.has(folder)) this.emit({ type: "folder_upsert", relativePath: folder });
		}
	}

	private async commitRemoval(asset: Asset, notify: boolean): Promise<void> {
		await this.handlers.removeAsset(asset);
		if (notify) this.emit({ type: "remove", assetId: asset.assetId });
	}

	getPaths(): LibraryPaths {
		if (!this.paths) throw new Error("No library is open");
		return this.paths;
	}

	private requirePaths(): LibraryPaths {
		return this.getPaths();
	}

	private folderAbsolute(relativePath: string): string {
		const paths = this.requirePaths();
		return relativePath ? paths.toAbsolutePath(relativePath) : paths.root;
	}

	private async pathExists(relativePath: string): Promise<boolean> {
		try {
			await stat(this.folderAbsolute(relativePath));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	private async ensureInbox(): Promise<void> {
		if (await this.pathExists(COMPOSER_INBOX_FOLDER)) {
			await this.requireDirectory(COMPOSER_INBOX_FOLDER);
			this.trackFolder(COMPOSER_INBOX_FOLDER);
			return;
		}
		await mkdir(this.folderAbsolute(COMPOSER_INBOX_FOLDER));
		this.trackFolder(COMPOSER_INBOX_FOLDER);
	}

	private async requireDirectory(relativePath: string): Promise<void> {
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(this.folderAbsolute(relativePath));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new Error("Folder not found");
			}
			throw error;
		}
		if (!info.isDirectory()) throw new Error("Destination is not a folder");
	}

	private async uniqueName(parentRelativePath: string, base: string): Promise<string> {
		let n = 0;
		while (true) {
			const name = n === 0 ? base : `${base} ${n + 1}`;
			if (!(await this.pathExists(joinRelative(parentRelativePath, name)))) return name;
			n += 1;
		}
	}

	private async uniqueFilename(parentRelativePath: string, stem: string, extension: string): Promise<string> {
		let n = 0;
		while (true) {
			const filename = n === 0 ? `${stem}${extension}` : `${stem} ${n + 1}${extension}`;
			if (!(await this.pathExists(joinRelative(parentRelativePath, filename)))) return filename;
			n += 1;
		}
	}

	private async placeOnePath(absolutePath: string, destFolder: string, move: boolean): Promise<PlacedEntry | null> {
		const paths = this.requirePaths();
		const name = basename(absolutePath);
		if (name === ".loom" || name === ".agents" || name === ".DS_Store") {
			throw new Error(`${name} cannot be imported.`);
		}

		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(absolutePath);
		} catch (error) {
			if (move && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw new Error(`${name} could not be read.`);
		}
		if (!info.isFile() && !info.isDirectory()) throw new Error(`${name} cannot be imported.`);
		if (paths.isIgnoredPath(absolutePath)) throw new Error(`${name} cannot be imported.`);
		if (info.isDirectory() && containsPath(absolutePath, this.folderAbsolute(destFolder))) {
			throw new Error("Cannot paste a folder into itself");
		}

		let relativePath: string | undefined;
		try {
			relativePath = paths.toRelativePath(absolutePath);
		} catch {
			relativePath = undefined;
		}

		if (relativePath !== undefined) {
			if (info.isDirectory()) {
				const next = move
					? await this.moveFolderInto(relativePath, destFolder)
					: await this.copyFolderInto(relativePath, destFolder);
				return { kind: "folder", relativePath: next };
			}
			let asset = await this.metadata.getAssetByPath(relativePath);
			if (!asset) {
				asset = await this.indexFile(relativePath);
				if (!asset) throw new Error(`${name} cannot be imported.`);
			}
			const next = move
				? await this.moveAssetInto(asset.assetId, destFolder)
				: await this.copyAssetInto(asset.assetId, destFolder);
			return { kind: "asset", asset: next };
		}

		if (info.isDirectory()) {
			const desired = assertEntryName(name);
			const folderName = await this.pathExists(joinRelative(destFolder, desired))
				? await this.uniqueName(destFolder, `${desired} copy`)
				: desired;
			const destRelative = joinRelative(destFolder, folderName);
			await this.transferExternal(absolutePath, this.folderAbsolute(destRelative), true, move);
			await this.indexTree(destRelative);
			return { kind: "folder", relativePath: destRelative };
		}

		const extension = extname(name);
		const stem = basename(name, extension);
		assertEntryName(stem || name);
		const filename = await this.uniqueCopyName(destFolder, name);
		const destRelative = joinRelative(destFolder, filename);
		await this.transferExternal(absolutePath, this.folderAbsolute(destRelative), false, move);
		const asset = await this.indexFile(destRelative);
		if (!asset) throw new Error(`Failed to import ${name}`);
		return { kind: "asset", asset };
	}

	private async transferExternal(source: string, dest: string, directory: boolean, move: boolean): Promise<void> {
		if (move) {
			try {
				await rename(source, dest);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			}
		}
		if (directory) await cp(source, dest, { recursive: true });
		else await copyFile(source, dest);
		if (move) await rm(source, { recursive: directory });
	}

	private async uniqueCopyName(parentRelativePath: string, desired: string): Promise<string> {
		if (!(await this.pathExists(joinRelative(parentRelativePath, desired)))) return desired;
		const extension = extname(desired);
		const stem = basename(desired, extension);
		let copyNumber = 1;
		while (true) {
			const filename = copyFilename(stem, extension, copyNumber);
			if (!(await this.pathExists(joinRelative(parentRelativePath, filename)))) return filename;
			copyNumber += 1;
		}
	}

	private trackFolder(relativePath: string): void {
		if (this.folders.has(relativePath)) return;
		this.folders.add(relativePath);
		this.emit({ type: "folder_upsert", relativePath });
	}

	private async rewriteFolderPrefix(oldPrefix: string, newPrefix: string): Promise<void> {
		const nextFolders: string[] = [];
		for (const folder of [...this.folders]) {
			const rewritten = rewriteRelativePrefix(folder, oldPrefix, newPrefix);
			if (rewritten === undefined) continue;
			this.folders.delete(folder);
			nextFolders.push(rewritten);
		}
		for (const folder of nextFolders) this.folders.add(folder);

		for (const asset of await this.metadata.listAssets()) {
			const relativePath = rewriteRelativePrefix(asset.relativePath, oldPrefix, newPrefix);
			if (relativePath === undefined) continue;
			const updated: Asset = {
				...asset,
				relativePath,
				filename: posixBasename(relativePath),
			};
			await this.handlers.upsertAsset(updated);
			this.emit({ type: "upsert", asset: updated });
		}

		this.emit({ type: "folder_remove", relativePath: oldPrefix });
		for (const folder of nextFolders.sort((a, b) => a.localeCompare(b))) {
			this.emit({ type: "folder_upsert", relativePath: folder });
		}
	}

	private async indexTree(relativePath: string): Promise<void> {
		const previousFolders = new Set(this.folders);
		this.folders.add(relativePath);
		const files: ReconcileDiskFile[] = [];
		await this.collectLibraryFiles(this.folderAbsolute(relativePath), files);
		for (const folder of [...this.folders].sort((a, b) => a.localeCompare(b))) {
			if (!previousFolders.has(folder)) this.emit({ type: "folder_upsert", relativePath: folder });
		}
		for (const file of files) await this.indexFile(file.relativePath);
	}

	private async relocateAsset(asset: Asset, relativePath: string): Promise<Asset> {
		if (relativePath === asset.relativePath) return asset;
		const paths = this.requirePaths();
		const filename = posixBasename(relativePath);
		const oldPath = paths.toAbsolutePath(asset.relativePath);
		const newPath = paths.toAbsolutePath(relativePath);
		const oldInfo = await statAssetFile(oldPath);
		try {
			const targetInfo = await statAssetFile(newPath);
			if (targetInfo.fileSystemId === null || oldInfo.fileSystemId === null || targetInfo.fileSystemId !== oldInfo.fileSystemId) {
				throw new Error(`A file named “${filename}” already exists`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		// Reserve the new path before fs.rename so watcher add/unlink events keep
		// the same asset id rather than briefly creating a second identity.
		const reserved: Asset = { ...asset, filename, relativePath, fileSystemId: oldInfo.fileSystemId };
		await this.handlers.upsertAsset(reserved);
		try {
			await rename(oldPath, newPath);
		} catch (error) {
			await this.handlers.upsertAsset(asset);
			throw error;
		}

		const info = await statAssetFile(newPath);
		const moved: Asset = {
			...reserved,
			size: info.size,
			modifiedAt: info.modifiedAt,
			fileSystemId: info.fileSystemId,
		};
		await this.handlers.upsertAsset(moved);
		this.emit({ type: "upsert", asset: moved });
		return moved;
	}

	private async requireAsset(assetId: string): Promise<Asset> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return asset;
	}

	notifyEnrichment(assetId: string): void {
		this.emit({ type: "enrichment", assetId });
	}

	notifyTextEmbed(assetId: string): void {
		this.emit({ type: "text_embed", assetId });
	}

	notifyImageVlm(assetId: string): void {
		this.emit({ type: "image_vlm", assetId });
	}

	notifyVideoVlm(assetId: string): void {
		this.emit({ type: "video_vlm", assetId });
	}

	notifyAudioWriteup(assetId: string): void {
		this.emit({ type: "audio_writeup", assetId });
	}

	private emit(change: LibraryChange): void {
		for (const listener of this.listeners) listener(change);
	}
}

/** Drop paths nested inside another selected path so a folder and its children are one item. */
function rootAbsolutePaths(absolutePaths: string[]): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const raw of absolutePaths) {
		if (!raw.trim()) continue;
		const absolutePath = resolve(raw);
		const key = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(absolutePath);
	}
	return unique.filter((absolutePath) => !unique.some((other) => {
		if (other === absolutePath) return false;
		return containsPath(other, absolutePath);
	}));
}

function containsPath(parent: string, child: string): boolean {
	const value = relative(parent, child);
	return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function ancestorFolders(relativePath: string): string[] {
	const parts = relativePath.split("/").filter(Boolean);
	parts.pop();
	const folders: string[] = [];
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		folders.push(current);
	}
	return folders;
}

async function renameRetry(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 8 || (code !== "EPERM" && code !== "EACCES")) throw error;
			await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
		}
	}
}
