import { randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
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
	copyFilename,
	joinRelative,
	parentRelative,
	posixBasename,
	rewriteRelativePrefix,
	wouldNestInside,
} from "./names.ts";
import { LibraryPaths } from "./paths.ts";
import { reconcileOpenAssets, type ReconcileDiskFile } from "./reconcile.ts";
import { LibraryWatcher, type LibraryFileEvent } from "./watcher.ts";

type LibraryListener = (change: LibraryChange) => void;

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
		await this.stopWatcher();
		await this.metadata.close();

		const info = await stat(rootPath);
		if (!info.isDirectory()) throw new Error(`Not a directory: ${rootPath}`);

		this.paths = new LibraryPaths(rootPath);
		this.folders.clear();
		await this.metadata.open(this.paths);
		await this.syncFromDisk(false);

		const watcher = new LibraryWatcher(this.paths);
		this.watcher = watcher;
		await watcher.start((event) => this.enqueueFileEvent(event));

		const snapshot = await this.getSnapshot();
		this.emit({ type: "reset", snapshot });
		return snapshot;
	}

	async getSnapshot(): Promise<LibrarySnapshot> {
		if (!this.paths) return { rootPath: null, folders: [], assets: [] };
		return {
			rootPath: this.paths.root,
			folders: [...this.folders].sort((a, b) => a.localeCompare(b)),
			assets: await this.metadata.listAssets(),
		};
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
		const paths = this.requirePaths();
		const asset = await this.requireAsset(assetId);
		const stem = requestedStem.trim();
		if (!stem || stem === "." || stem === ".." || /[\\/\0]/.test(stem)) {
			throw new Error("Enter a valid file name");
		}

		const extension = extname(asset.filename);
		const filename = `${stem}${extension}`;
		if (filename === asset.filename) return asset;

		const oldPath = paths.toAbsolutePath(asset.relativePath);
		const parent = dirname(asset.relativePath);
		const relativePath = parent === "." ? filename : `${parent}/${filename}`;
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
		const renamed: Asset = {
			...reserved,
			size: info.size,
			modifiedAt: info.modifiedAt,
			fileSystemId: info.fileSystemId,
		};
		await this.handlers.upsertAsset(renamed);
		this.emit({ type: "upsert", asset: renamed });
		return renamed;
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
		await this.stopWatcher();
		await this.updateQueue;
		this.paths = null;
		this.folders.clear();
		await this.metadata.close();
	}

	private async stopWatcher(): Promise<void> {
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

	private emit(change: LibraryChange): void {
		for (const listener of this.listeners) listener(change);
	}
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
