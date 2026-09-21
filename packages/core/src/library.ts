import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
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
			if (paths.isLoomPath(absolutePath) || entry.isSymbolicLink()) continue;
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
		if (paths.isLoomPath(absolutePath)) return;

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
		if (paths.isLoomPath(absolutePath)) return;
		const relativePath = paths.toRelativePath(absolutePath);
		if (this.folders.has(relativePath)) return;
		this.folders.add(relativePath);
		this.emit({ type: "folder_upsert", relativePath });
	}

	private async removeFolder(absolutePath: string): Promise<void> {
		const paths = this.requirePaths();
		if (paths.isLoomPath(absolutePath)) return;
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
		if (paths.isLoomPath(absolutePath)) return;
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

	private emit(change: LibraryChange): void {
		for (const listener of this.listeners) listener(change);
	}
}
