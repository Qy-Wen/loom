import type { LibraryChange, LibrarySnapshot } from "./asset.ts";
import { Library } from "./library.ts";
import { LibraryPaths } from "./library-paths.ts";
import { InMemoryGraphStore, InMemoryMetadataStore } from "./memory-stores.ts";
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
		this.metadataStore = options.metadataStore ?? new InMemoryMetadataStore();
		this.graphStore = options.graphStore ?? new InMemoryGraphStore();
		this.library = new Library(this.metadataStore);
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

	subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
		return this.library.subscribe(listener);
	}

	async close(): Promise<void> {
		await Promise.all([this.library.close(), this.graphStore.close()]);
	}
}
