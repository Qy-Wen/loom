import type { Asset } from "./asset.ts";
import type { AssetRelation, GraphStore, MetadataStore } from "./stores.ts";

/** Volatile MetadataStore used by focused tests and explicit dependency injection. */
export class InMemoryMetadataStore implements MetadataStore {
	private readonly assets = new Map<string, Asset>();
	private readonly assetIdByPath = new Map<string, string>();
	private readonly assetIdByFileSystemId = new Map<string, string>();

	async open(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
	}

	async close(): Promise<void> {
		this.assets.clear();
		this.assetIdByPath.clear();
		this.assetIdByFileSystemId.clear();
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

	async removeAsset(assetId: string): Promise<void> {
		const asset = this.assets.get(assetId);
		if (!asset) return;
		this.assets.delete(assetId);
		this.assetIdByPath.delete(asset.relativePath);
		if (asset.fileSystemId) this.assetIdByFileSystemId.delete(asset.fileSystemId);
	}

}

/** Temporary graph implementation until the persistent graph store lands. */
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
