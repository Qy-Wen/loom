import type { Asset } from "./asset.ts";
import type { LibraryPaths } from "./library-paths.ts";

export interface MetadataStore {
	open(paths: LibraryPaths): Promise<void>;
	close(): Promise<void>;
	upsertAsset(asset: Asset): Promise<void>;
	getAsset(assetId: string): Promise<Asset | undefined>;
	getAssetByPath(relativePath: string): Promise<Asset | undefined>;
	listAssets(): Promise<Asset[]>;
	removeAsset(assetId: string): Promise<void>;
}

export interface AssetRelation {
	relationId: string;
	fromAssetId: string;
	toAssetId: string;
	type: string;
}

export interface GraphStore {
	open(paths: LibraryPaths): Promise<void>;
	close(): Promise<void>;
	upsertRelation(relation: AssetRelation): Promise<void>;
	listRelations(assetId: string): Promise<AssetRelation[]>;
	removeRelation(relationId: string): Promise<void>;
}
