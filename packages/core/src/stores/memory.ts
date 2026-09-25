import type { Asset } from "../model/asset.ts";
import type { AssetEnrichment } from "../model/enrichment.ts";
import {
	assertPropertyDefinition,
	assertPropertyValue,
	type AssetPropertyValue,
	type PropertyDefinition,
} from "../model/property.ts";
import { documentMatchesTokens, searchDocument, searchTokens } from "../retrieval/text.ts";
import type { AssetRelation, GraphStore, MetadataStore } from "./types.ts";

/** Volatile MetadataStore used by focused tests and explicit dependency injection. */
export class InMemoryMetadataStore implements MetadataStore {
	private readonly assets = new Map<string, Asset>();
	private readonly assetIdByPath = new Map<string, string>();
	private readonly assetIdByFileSystemId = new Map<string, string>();
	private readonly properties = new Map<string, PropertyDefinition>();
	private readonly propertyIdByName = new Map<string, string>();
	private readonly assetProperties = new Map<string, Map<string, AssetPropertyValue>>();
	private readonly enrichments = new Map<string, AssetEnrichment>();
	private volumeId: string | undefined;

	async open(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
		this.properties.clear();
		this.propertyIdByName.clear();
		this.assetProperties.clear();
		this.enrichments.clear();
		this.volumeId = undefined;
	}

	async close(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
		this.properties.clear();
		this.propertyIdByName.clear();
		this.assetProperties.clear();
		this.enrichments.clear();
		this.volumeId = undefined;
	}

	async upsertAsset(asset: Asset): Promise<void> {
		const previous = this.assets.get(asset.assetId);
		if (previous && previous.relativePath !== asset.relativePath) {
			this.assetIdByPath.delete(previous.relativePath);
		}
		if (previous?.fileSystemId && previous.fileSystemId !== asset.fileSystemId) {
			this.assetIdByFileSystemId.delete(previous.fileSystemId);
		}

		const replacedId = this.assetIdByPath.get(asset.relativePath);
		if (replacedId && replacedId !== asset.assetId) {
			const replaced = this.assets.get(replacedId);
			this.assets.delete(replacedId);
			if (replaced?.fileSystemId) this.assetIdByFileSystemId.delete(replaced.fileSystemId);
			this.enrichments.delete(replacedId);
		}

		this.assets.set(asset.assetId, asset);
		this.assetIdByPath.set(asset.relativePath, asset.assetId);
		if (asset.fileSystemId) this.assetIdByFileSystemId.set(asset.fileSystemId, asset.assetId);
	}

	async getAsset(assetId: string): Promise<Asset | undefined> {
		return this.assets.get(assetId);
	}

	async getAssetByPath(relativePath: string): Promise<Asset | undefined> {
		const assetId = this.assetIdByPath.get(relativePath);
		return assetId ? this.assets.get(assetId) : undefined;
	}

	async getAssetByFileSystemId(fileSystemId: string): Promise<Asset | undefined> {
		const assetId = this.assetIdByFileSystemId.get(fileSystemId);
		return assetId ? this.assets.get(assetId) : undefined;
	}

	async listAssets(): Promise<Asset[]> {
		return [...this.assets.values()].sort((a, b) =>
			a.relativePath.localeCompare(b.relativePath),
		);
	}

	async replaceAssets(assets: Asset[]): Promise<void> {
		const nextAssetIds = new Set(assets.map((asset) => asset.assetId));
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
		for (const asset of assets) {
			this.assets.set(asset.assetId, asset);
			this.assetIdByPath.set(asset.relativePath, asset.assetId);
			if (asset.fileSystemId) this.assetIdByFileSystemId.set(asset.fileSystemId, asset.assetId);
		}
		for (const assetId of this.assetProperties.keys()) {
			if (!nextAssetIds.has(assetId)) this.assetProperties.delete(assetId);
		}
		for (const assetId of this.enrichments.keys()) {
			if (!nextAssetIds.has(assetId)) this.enrichments.delete(assetId);
		}
	}

	async removeAsset(assetId: string): Promise<void> {
		const asset = this.assets.get(assetId);
		if (!asset) return;
		this.assets.delete(assetId);
		this.assetIdByPath.delete(asset.relativePath);
		if (asset.fileSystemId) this.assetIdByFileSystemId.delete(asset.fileSystemId);
		this.assetProperties.delete(assetId);
		this.enrichments.delete(assetId);
	}

	async getLibraryVolumeId(): Promise<string | undefined> {
		return this.volumeId;
	}

	async setLibraryVolumeId(volumeId: string): Promise<void> {
		this.volumeId = volumeId;
	}

	async createProperty(property: PropertyDefinition): Promise<void> {
		assertPropertyDefinition(property);
		if (this.properties.has(property.propertyId)) throw new Error("Property already exists");
		const nameKey = normalizePropertyName(property.name);
		if (this.propertyIdByName.has(nameKey)) throw new Error("Property name already exists");
		this.properties.set(property.propertyId, property);
		this.propertyIdByName.set(nameKey, property.propertyId);
	}

	async updateProperty(property: PropertyDefinition): Promise<void> {
		assertPropertyDefinition(property);
		const previous = this.properties.get(property.propertyId);
		if (!previous) throw new Error("Property not found");
		const nameKey = normalizePropertyName(property.name);
		const nameOwner = this.propertyIdByName.get(nameKey);
		if (nameOwner && nameOwner !== property.propertyId) throw new Error("Property name already exists");
		if (previous.type !== property.type && this.hasValuesForProperty(property.propertyId)) {
			throw new Error("Cannot change the type of a property that has values");
		}
		this.propertyIdByName.delete(normalizePropertyName(previous.name));
		this.properties.set(property.propertyId, { ...property, createdAt: previous.createdAt });
		this.propertyIdByName.set(nameKey, property.propertyId);
	}

	async getProperty(propertyId: string): Promise<PropertyDefinition | undefined> {
		return this.properties.get(propertyId);
	}

	async listProperties(): Promise<PropertyDefinition[]> {
		return [...this.properties.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async removeProperty(propertyId: string): Promise<void> {
		const property = this.properties.get(propertyId);
		if (!property) return;
		this.properties.delete(propertyId);
		this.propertyIdByName.delete(normalizePropertyName(property.name));
		for (const values of this.assetProperties.values()) values.delete(propertyId);
	}

	async setAssetProperty(value: AssetPropertyValue): Promise<void> {
		if (!this.assets.has(value.assetId)) throw new Error("Asset not found");
		const property = this.properties.get(value.propertyId);
		if (!property) throw new Error("Property not found");
		assertPropertyValue(property.type, value.value);
		let values = this.assetProperties.get(value.assetId);
		if (!values) {
			values = new Map();
			this.assetProperties.set(value.assetId, values);
		}
		values.set(value.propertyId, value);
	}

	async listAssetProperties(assetId: string): Promise<AssetPropertyValue[]> {
		return [...(this.assetProperties.get(assetId)?.values() ?? [])].sort((a, b) =>
			a.propertyId.localeCompare(b.propertyId),
		);
	}

	async listAllAssetProperties(): Promise<AssetPropertyValue[]> {
		return [...this.assetProperties.values()]
			.flatMap((values) => [...values.values()])
			.sort((a, b) => a.assetId.localeCompare(b.assetId) || a.propertyId.localeCompare(b.propertyId));
	}

	async removeAssetProperty(assetId: string, propertyId: string): Promise<void> {
		this.assetProperties.get(assetId)?.delete(propertyId);
	}

	async getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined> {
		return this.enrichments.get(assetId);
	}

	async listAssetEnrichments(): Promise<AssetEnrichment[]> {
		return [...this.enrichments.values()];
	}

	async upsertAssetEnrichment(record: AssetEnrichment): Promise<void> {
		if (!this.assets.has(record.assetId)) throw new Error("Asset not found");
		this.enrichments.set(record.assetId, record);
	}

	async searchAssetIds(query: string): Promise<string[]> {
		const tokens = searchTokens(query);
		if (tokens.length === 0) return [];
		const matches: string[] = [];
		for (const asset of this.assets.values()) {
			const values = [...(this.assetProperties.get(asset.assetId)?.values() ?? [])].map((item) => item.value);
			const document = searchDocument(asset.filename, asset.relativePath, values, this.enrichments.get(asset.assetId));
			if (documentMatchesTokens(document, tokens)) matches.push(asset.assetId);
		}
		return matches;
	}

	private hasValuesForProperty(propertyId: string): boolean {
		for (const values of this.assetProperties.values()) {
			if (values.has(propertyId)) return true;
		}
		return false;
	}

}

function normalizePropertyName(name: string): string {
	return name.trim().toLowerCase();
}

/** Volatile GraphStore used by focused tests and explicit dependency injection. */
export class InMemoryGraphStore implements GraphStore {
	private readonly relations = new Map<string, AssetRelation>();

	async open(): Promise<void> {
		this.relations.clear();
	}

	async close(): Promise<void> {
		this.relations.clear();
	}

	async ensureAsset(): Promise<void> {}

	async removeAsset(assetId: string): Promise<void> {
		for (const [relationId, relation] of this.relations) {
			if (relation.fromAssetId === assetId || relation.toAssetId === assetId) {
				this.relations.delete(relationId);
			}
		}
	}

	async upsertRelation(relation: AssetRelation): Promise<void> {
		for (const [relationId, existing] of this.relations) {
			if (
				existing.fromAssetId === relation.fromAssetId &&
				existing.toAssetId === relation.toAssetId &&
				existing.type === relation.type
			) {
				this.relations.delete(relationId);
			}
		}
		this.relations.set(relation.relationId, relation);
	}

	async listRelations(assetId: string): Promise<AssetRelation[]> {
		return [...this.relations.values()]
			.filter((relation) => relation.fromAssetId === assetId || relation.toAssetId === assetId)
			.sort((a, b) => a.type.localeCompare(b.type) || a.relationId.localeCompare(b.relationId));
	}

	async removeRelation(relationId: string): Promise<void> {
		this.relations.delete(relationId);
	}
}
