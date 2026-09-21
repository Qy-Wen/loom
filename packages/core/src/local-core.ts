import { randomUUID } from "node:crypto";
import { Library } from "./library/library.ts";
import { LibraryHandlers, NoopGraphHandlers } from "./library/handlers.ts";
import { LibraryPaths } from "./library/paths.ts";
import type { Asset, LibraryChange, LibrarySnapshot } from "./model/asset.ts";
import type {
	AssetPropertyValue,
	PropertyDefinition,
	PropertySnapshot,
	PropertyType,
	PropertyValue,
} from "./model/property.ts";
import { InMemoryGraphStore } from "./stores/memory.ts";
import { SqliteMetadataStore } from "./stores/sqlite.ts";
import type { GraphStore, MetadataStore } from "./stores/types.ts";

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

	async getPropertySnapshot(): Promise<PropertySnapshot> {
		const [properties, values] = await Promise.all([
			this.metadataStore.listProperties(),
			this.metadataStore.listAllAssetProperties(),
		]);
		return { properties, values };
	}

	async createProperty(name: string, type: PropertyType): Promise<PropertyDefinition> {
		const property: PropertyDefinition = {
			propertyId: randomUUID(),
			name: name.trim(),
			type,
			createdAt: Date.now(),
		};
		await this.metadataStore.createProperty(property);
		return property;
	}

	async updateProperty(
		propertyId: string,
		name: string,
		type: PropertyType,
	): Promise<PropertyDefinition> {
		const previous = await this.metadataStore.getProperty(propertyId);
		if (!previous) throw new Error("Property not found");
		const property = { ...previous, name: name.trim(), type };
		await this.metadataStore.updateProperty(property);
		return property;
	}

	removeProperty(propertyId: string): Promise<void> {
		return this.metadataStore.removeProperty(propertyId);
	}

	async setAssetProperty(
		assetId: string,
		propertyId: string,
		value: PropertyValue,
	): Promise<AssetPropertyValue> {
		const assetProperty = { assetId, propertyId, value };
		await this.metadataStore.setAssetProperty(assetProperty);
		return assetProperty;
	}

	removeAssetProperty(assetId: string, propertyId: string): Promise<void> {
		return this.metadataStore.removeAssetProperty(assetId, propertyId);
	}

	subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
		return this.library.subscribe(listener);
	}

	async close(): Promise<void> {
		await Promise.all([this.library.close(), this.graphStore.close()]);
	}
}
