import { randomUUID } from "node:crypto";
import { EnrichmentService } from "./enrichment/service.ts";
import { Library } from "./library/library.ts";
import { LibraryHandlers, NoopGraphHandlers } from "./library/handlers.ts";
import { LibraryPaths } from "./library/paths.ts";
import type { Asset, LibraryChange, LibrarySnapshot } from "./model/asset.ts";
import type { AssetEnrichment } from "./model/enrichment.ts";
import type {
	AssetPropertyValue,
	PropertyDefinition,
	PropertySnapshot,
	PropertyType,
	PropertyValue,
} from "./model/property.ts";
import {
	toSearchItem,
	type AssetDetailResult,
	type AssetPropertyFilter,
	type AssetPropertyView,
	type AssetSearchItem,
	type AssetSearchQuery,
	type AssetSearchResult,
} from "./model/retrieval.ts";
import { matchesPropertyFilters } from "./retrieval/filter.ts";
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
	private readonly enrichment: EnrichmentService;

	constructor(options: LocalCoreOptions = {}) {
		this.metadataStore = options.metadataStore ?? new SqliteMetadataStore();
		this.graphStore = options.graphStore ?? new InMemoryGraphStore();
		this.library = new Library(new LibraryHandlers(this.metadataStore, new NoopGraphHandlers()));
		this.enrichment = new EnrichmentService(
			this.metadataStore,
			(assetId) => this.library.getAssetFilePath(assetId),
		);
		this.library.subscribe((change) => {
			if (change.type === "reset") {
				void this.enrichment.refreshStale(change.snapshot.assets).then((records) => {
					for (const record of records) this.library.notifyEnrichment(record.assetId);
				}).catch(() => undefined);
			} else if (change.type === "upsert") {
				void this.enrichment.refreshStale([change.asset]).then((records) => {
					for (const record of records) this.library.notifyEnrichment(record.assetId);
				}).catch(() => undefined);
			}
		});
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

	async searchAssets(query: AssetSearchQuery = {}): Promise<AssetSearchResult> {
		const [assets, definitions, values] = await Promise.all([
			this.metadataStore.listAssets(),
			this.metadataStore.listProperties(),
			this.metadataStore.listAllAssetProperties(),
		]);
		const definitionsById = new Map(definitions.map((property) => [property.propertyId, property]));
		const definitionByName = new Map(
			definitions.map((property) => [property.name.trim().toLowerCase(), property]),
		);
		const propertiesByAsset = new Map<string, AssetPropertyView[]>();
		for (const value of values) {
			const definition = definitionsById.get(value.propertyId);
			if (!definition) continue;
			const list = propertiesByAsset.get(value.assetId) ?? [];
			list.push({
				propertyId: definition.propertyId,
				name: definition.name,
				type: definition.type,
				value: value.value,
			});
			propertiesByAsset.set(value.assetId, list);
		}

		const textQuery = query.query?.trim().toLowerCase();
		const filters = query.properties ?? [];
		const matches: AssetSearchItem[] = [];
		for (const asset of assets) {
			if (query.type && asset.type !== query.type) continue;
			const properties = propertiesByAsset.get(asset.assetId) ?? [];
			if (textQuery) {
				const searchable = [asset.filename, asset.relativePath, ...properties.map((item) => String(item.value))];
				if (!searchable.some((value) => value.toLowerCase().includes(textQuery))) continue;
			}
			if (!matchesPropertyFilters(properties, filters, definitionByName)) continue;
			matches.push(toSearchItem(asset, properties));
		}

		const total = matches.length;
		const limit = Math.min(100, Math.max(1, Math.trunc(query.limit ?? 20)));
		return { kind: "asset_list", assets: matches.slice(0, limit), total };
	}

	async inspectAsset(assetId: string): Promise<AssetDetailResult> {
		const asset = await this.metadataStore.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		const [definitions, values] = await Promise.all([
			this.metadataStore.listProperties(),
			this.metadataStore.listAssetProperties(assetId),
		]);
		const definitionsById = new Map(definitions.map((property) => [property.propertyId, property]));
		const properties: AssetPropertyView[] = [];
		for (const value of values) {
			const definition = definitionsById.get(value.propertyId);
			if (!definition) continue;
			properties.push({
				propertyId: definition.propertyId,
				name: definition.name,
				type: definition.type,
				value: value.value,
			});
		}
		return {
			kind: "asset_detail",
			...toSearchItem(asset, properties),
			createdAt: asset.createdAt,
			previewRef: `loom-asset://asset/${encodeURIComponent(asset.assetId)}?v=${asset.modifiedAt}`,
			enrichment: await this.metadataStore.getAssetEnrichment(asset.assetId),
		};
	}

	getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		return this.metadataStore.getAssetEnrichment(assetId);
	}

	async analyzeAsset(assetId: string): Promise<AssetEnrichment> {
		const record = await this.enrichment.analyze(assetId);
		this.library.notifyEnrichment(assetId);
		return record;
	}

	refreshEnrichment(assets: Asset[]): Promise<AssetEnrichment[]> {
		return this.enrichment.refreshStale(assets);
	}

	subscribeLibrary(listener: (change: LibraryChange) => void): () => void {
		return this.library.subscribe(listener);
	}

	async close(): Promise<void> {
		await Promise.all([this.library.close(), this.graphStore.close()]);
	}
}
