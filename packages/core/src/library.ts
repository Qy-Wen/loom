import { randomUUID } from "node:crypto";
import { copyFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
	assetTypeFromPath,
	type Asset,
	type LibraryChange,
	type LibrarySnapshot,
} from "./asset.ts";
import { LibraryPaths } from "./library-paths.ts";
import { LibraryWatcher, type LibraryFileEvent } from "./library-watcher.ts";
import type { MetadataStore } from "./stores.ts";

type LibraryListener = (change: LibraryChange) => void;

/**
 * Reconciles the filesystem (source of truth) with a MetadataStore and emits
 * incremental changes for the UI. Watcher events are serialized through one
 * queue so add/remove races cannot mutate the store concurrently.
 */
export class Library {
	private paths: LibraryPaths | null = null;
	private watcher: LibraryWatcher | null = null;
	private readonly folders = new Set<string>();
	private readonly listeners = new Set<LibraryListener>();
	private updateQueue: Promise<void> = Promise.resolve();
	private readonly metadataStore: MetadataStore;

	constructor(metadataStore: MetadataStore) {
		this.metadataStore = metadataStore;
	}

	async open(rootPath: string): Promise<LibrarySnapshot> {
		await this.stopWatcher();
		await this.metadataStore.close();

		const info = await stat(rootPath);
		if (!info.isDirectory()) throw new Error(`Not a directory: ${rootPath}`);

		this.paths = new LibraryPaths(rootPath);
		this.folders.clear();
		await this.metadataStore.open(this.paths);

		const staleAssets = new Map(
			(await this.metadataStore.listAssets()).map((asset) => [asset.relativePath, asset]),
		);
		await this.scanDirectory(this.paths.root, staleAssets);
		for (const staleAsset of staleAssets.values()) {
			await this.metadataStore.removeAsset(staleAsset.assetId);
		}

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
			assets: await this.metadataStore.listAssets(),
		};
	}

	subscribe(listener: LibraryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getAssetFilePath(assetId: string): Promise<string | undefined> {
		if (!this.paths) return undefined;
		const asset = await this.metadataStore.getAsset(assetId);
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

		const oldInfo = await stat(oldPath);
		try {
			const targetInfo = await stat(newPath);
			if (targetInfo.dev !== oldInfo.dev || targetInfo.ino !== oldInfo.ino) {
				throw new Error(`A file named “${filename}” already exists`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		// Reserve the new path before fs.rename so watcher add/unlink events keep
		// the same asset id rather than briefly creating a second identity.
		const reserved: Asset = { ...asset, filename, relativePath };
		await this.metadataStore.upsertAsset(reserved);
		try {
			await rename(oldPath, newPath);
		} catch (error) {
			await this.metadataStore.upsertAsset(asset);
			throw error;
		}

		const info = await stat(newPath);
		const renamed: Asset = { ...reserved, size: info.size, modifiedAt: info.mtimeMs };
		await this.metadataStore.upsertAsset(renamed);
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
		await this.metadataStore.upsertAsset(reserved);
		try {
			await copyFile(sourcePath, destinationPath);
		} catch (error) {
			await this.metadataStore.removeAsset(reserved.assetId);
			throw error;
		}

		const info = await stat(destinationPath);
		const duplicate: Asset = {
			...reserved,
			size: info.size,
			createdAt: info.birthtimeMs || info.ctimeMs,
			modifiedAt: info.mtimeMs,
		};
		await this.metadataStore.upsertAsset(duplicate);
		this.emit({ type: "upsert", asset: duplicate });
		return duplicate;
	}

	async forgetAsset(assetId: string): Promise<void> {
		const asset = await this.metadataStore.getAsset(assetId);
		if (!asset) return;
		await this.metadataStore.removeAsset(assetId);
		this.emit({ type: "remove", assetId });
	}

	async close(): Promise<void> {
		await this.stopWatcher();
		await this.updateQueue;
		this.paths = null;
		this.folders.clear();
		await this.metadataStore.close();
	}

	private async stopWatcher(): Promise<void> {
		const watcher = this.watcher;
		this.watcher = null;
		if (watcher) await watcher.close();
		await this.updateQueue;
	}

	private async scanDirectory(
		directory: string,
		staleAssets: Map<string, Asset>,
	): Promise<void> {
		const paths = this.requirePaths();
		const entries = await readdir(directory, { withFileTypes: true });

		for (const entry of entries) {
			const absolutePath = join(directory, entry.name);
			if (paths.isIgnoredPath(absolutePath) || entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				this.folders.add(paths.toRelativePath(absolutePath));
				await this.scanDirectory(absolutePath, staleAssets);
			} else if (entry.isFile()) {
				staleAssets.delete(paths.toRelativePath(absolutePath));
				await this.upsertFile(absolutePath, false);
			}
		}
	}

	private enqueueFileEvent(event: LibraryFileEvent): void {
		// chokidar may emit bursts for one user operation; preserve their order.
		this.updateQueue = this.updateQueue
			.then(async () => {
				if (event.type === "error") {
					this.emit({ type: "error", message: event.error.message });
					return;
				}
				if (event.type === "upsert") await this.upsertFile(event.absolutePath, true);
				else if (event.type === "remove") await this.removeFile(event.absolutePath);
				else if (event.type === "folder_upsert") this.upsertFolder(event.absolutePath);
				else await this.removeFolder(event.absolutePath);
			})
			.catch((error) => {
				this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
			});
	}

	private async upsertFile(absolutePath: string, notify: boolean): Promise<void> {
		const paths = this.requirePaths();
		if (paths.isIgnoredPath(absolutePath)) return;

		let info;
		try {
			info = await stat(absolutePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!info.isFile()) return;

		const relativePath = paths.toRelativePath(absolutePath);
		const existing = await this.metadataStore.getAssetByPath(relativePath);
		const asset: Asset = {
			assetId: existing?.assetId ?? randomUUID(),
			relativePath,
			filename: basename(absolutePath),
			type: assetTypeFromPath(absolutePath),
			size: info.size,
			createdAt: info.birthtimeMs || info.ctimeMs,
			modifiedAt: info.mtimeMs,
		};
		await this.metadataStore.upsertAsset(asset);
		if (notify) this.emit({ type: "upsert", asset });
	}

	private upsertFolder(absolutePath: string): void {
		const paths = this.requirePaths();
		if (paths.isIgnoredPath(absolutePath)) return;
		const relativePath = paths.toRelativePath(absolutePath);
		if (this.folders.has(relativePath)) return;
		this.folders.add(relativePath);
		this.emit({ type: "folder_upsert", relativePath });
	}

	private async removeFolder(absolutePath: string): Promise<void> {
		const paths = this.requirePaths();
		if (paths.isIgnoredPath(absolutePath)) return;
		const relativePath = paths.toRelativePath(absolutePath);
		const prefix = `${relativePath}/`;
		for (const folder of [...this.folders]) {
			if (folder === relativePath || folder.startsWith(prefix)) this.folders.delete(folder);
		}
		for (const asset of await this.metadataStore.listAssets()) {
			if (!asset.relativePath.startsWith(prefix)) continue;
			await this.metadataStore.removeAsset(asset.assetId);
			this.emit({ type: "remove", assetId: asset.assetId });
		}
		this.emit({ type: "folder_remove", relativePath });
	}

	private async removeFile(absolutePath: string): Promise<void> {
		const paths = this.requirePaths();
		if (paths.isIgnoredPath(absolutePath)) return;
		const relativePath = paths.toRelativePath(absolutePath);
		const asset = await this.metadataStore.getAssetByPath(relativePath);
		if (!asset) return;
		await this.metadataStore.removeAsset(asset.assetId);
		this.emit({ type: "remove", assetId: asset.assetId });
	}

	private requirePaths(): LibraryPaths {
		if (!this.paths) throw new Error("No library is open");
		return this.paths;
	}

	private async requireAsset(assetId: string): Promise<Asset> {
		const asset = await this.metadataStore.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return asset;
	}

	private emit(change: LibraryChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
