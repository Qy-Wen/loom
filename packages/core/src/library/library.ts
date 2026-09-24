import { randomUUID } from "node:crypto";
import { copyFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
	type Asset,
	type LibraryChange,
	type LibrarySnapshot,
} from "../model/asset.ts";
import { statAssetFile, statVolumeId } from "./file-identity.ts";
import { diffLibraryAssets, LibraryHandlers } from "./handlers.ts";
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
		const paths = this.requirePaths();
		const source = await this.requireAsset(assetId);
		const sourcePath = paths.toAbsolutePath(source.relativePath);
		const extension = extname(source.filename);
		const stem = basename(source.filename, extension);
		const parent = dirname(source.relativePath);

		let copyNumber = 1;
		let filename = "";
		let relativePath = "";
		let destinationPath = "";
		while (true) {
			filename = `${stem} copy${copyNumber === 1 ? "" : ` ${copyNumber}`}${extension}`;
			relativePath = parent === "." ? filename : `${parent}/${filename}`;
			destinationPath = paths.toAbsolutePath(relativePath);
			try {
				await stat(destinationPath);
				copyNumber += 1;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
				throw error;
			}
		}

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

	async forgetAsset(assetId: string): Promise<void> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) return;
		await this.commitRemoval(asset, true);
	}

	async close(): Promise<void> {
		await this.stopWatcher();
		await this.updateQueue;
		this.paths = null;
		this.folders.clear();
		await this.metadata.close();
	}

	private async stopWatcher(): Promise<void> {
		const watcher = this.watcher;
		this.watcher = null;
		if (this.liveReconcileTimer) {
			clearTimeout(this.liveReconcileTimer);
			this.liveReconcileTimer = null;
		}
		if (watcher) await watcher.close();
		await this.updateQueue;
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

	private requirePaths(): LibraryPaths {
		if (!this.paths) throw new Error("No library is open");
		return this.paths;
	}

	private async requireAsset(assetId: string): Promise<Asset> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return asset;
	}

	notifyEnrichment(assetId: string): void {
		this.emit({ type: "enrichment", assetId });
	}

	private emit(change: LibraryChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
