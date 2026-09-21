import type { Asset, LibraryChange, LibrarySnapshot } from "./asset.ts";
import { LibraryHandlers, NoopGraphHandlers } from "./library-handlers.ts";
import { Library } from "./library.ts";
import { LibraryPaths } from "./library-paths.ts";
import { InMemoryGraphStore } from "./memory-stores.ts";
import { SqliteMetadataStore } from "./sqlite-metadata-store.ts";
import type { GraphStore, MetadataStore } from "./stores.ts";

export interface LocalCoreOptions {
	metadataStore?: MetadataStore;
	graphStore?: GraphStore;
}

/** Main-process facade. Renderer code talks to this only through typed IPC. */
export class LocalCore {
	readonly metadataStore: MetadataStore;
	readonly graphStore: GraphStore;
	private readonly library: Library;

	constructor(options: LocalCoreOptions = {}) {
		this.metadataStore = options.metadataStore ?? new SqliteMetadataStore();
		this.graphStore = options.graphStore ?? new InMemoryGraphStore();
		this.library = new Library(new LibraryHandlers(this.metadataStore, new NoopGraphHandlers()));
	}

	async openLibrary(rootPath: string): Promise<LibrarySnapshot> {
		await this.graphStore.close();
		await this.graphStore.open(new LibraryPaths(rootPath));
		return this.library.open(rootPath);
	}

	getLibrarySnapshot(): Promise<LibrarySnapshot> {
		return this.library.getSnapshot();
	}

	getAssetFilePath(assetId: string): Promise<string | undefined> {
		return this.library.getAssetFilePath(assetId);
	}

	renameAsset(assetId: string, stem: string): Promise<Asset> {
		return this.library.renameAsset(assetId, stem);
	}

	duplicateAsset(assetId: string): Promise<Asset> {
		return this.library.duplicateAsset(assetId);
	}

	forgetAsset(assetId: string): Promise<void> {
		return this.library.forgetAsset(assetId);
	}

	subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
		return this.library.subscribe(listener);
	}

	async close(): Promise<void> {
		await Promise.all([this.library.close(), this.graphStore.close()]);
	}
}
