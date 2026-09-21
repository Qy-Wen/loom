import type { Asset } from "./asset.ts";
import type { AssetRelation, GraphStore, MetadataStore } from "./stores.ts";

export class InMemoryMetadataStore implements MetadataStore {
	private readonly assets = new Map<string, Asset>();
	private readonly assetIdByPath = new Map<string, string>();

	async open(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
	}

	async close(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
	}

	async upsertAsset(asset: Asset): Promise<void> {
		const previous = this.assets.get(asset.assetId);
		if (previous && previous.relativePath !== asset.relativePath) {
			this.assetIdByPath.delete(previous.relativePath);
		}

		const replacedId = this.assetIdByPath.get(asset.relativePath);
		if (replacedId && replacedId !== asset.assetId) this.assets.delete(replacedId);

		this.assets.set(asset.assetId, asset);
		this.assetIdByPath.set(asset.relativePath, asset.assetId);
	}

	async getAsset(assetId: string): Promise<Asset | undefined> {
		return this.assets.get(assetId);
	}

	async getAssetByPath(relativePath: string): Promise<Asset | undefined> {
		const assetId = this.assetIdByPath.get(relativePath);
		return assetId ? this.assets.get(assetId) : undefined;
	}

	async listAssets(): Promise<Asset[]> {
		return [...this.assets.values()].sort((a, b) =>
			a.relativePath.localeCompare(b.relativePath),
		);
	}

	async removeAsset(assetId: string): Promise<void> {
		const asset = this.assets.get(assetId);
		if (!asset) return;
		this.assets.delete(assetId);
		this.assetIdByPath.delete(asset.relativePath);
	}

}

export class InMemoryGraphStore implements GraphStore {
	private readonly relations = new Map<string, AssetRelation>();

	async open(): Promise<void> {
		this.relations.clear();
	}

	async close(): Promise<void> {
		this.relations.clear();
	}

	async upsertRelation(relation: AssetRelation): Promise<void> {
		this.relations.set(relation.relationId, relation);
	}

	async listRelations(assetId: string): Promise<AssetRelation[]> {
		return [...this.relations.values()].filter(
			(relation) => relation.fromAssetId === assetId || relation.toAssetId === assetId,
		);
	}

	async removeRelation(relationId: string): Promise<void> {
		this.relations.delete(relationId);
	}

}
