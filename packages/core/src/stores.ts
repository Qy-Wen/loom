import type { Asset } from "./asset.ts";
import type { LibraryPaths } from "./library-paths.ts";

/**
 * Persistence boundary for derived asset metadata.
 * `open` switches the store to one library; paths are always library-relative.
 */
export interface MetadataStore {
	open(paths: LibraryPaths): Promise<void>;
	close(): Promise<void>;
	upsertAsset(asset: Asset): Promise<void>;
	getAsset(assetId: string): Promise<Asset | undefined>;
	getAssetByPath(relativePath: string): Promise<Asset | undefined>;
	getAssetByFileSystemId(fileSystemId: string): Promise<Asset | undefined>;
	listAssets(): Promise<Asset[]>;
	replaceAssets(assets: Asset[]): Promise<void>;
	removeAsset(assetId: string): Promise<void>;
	getLibraryVolumeId(): Promise<string | undefined>;
	setLibraryVolumeId(volumeId: string): Promise<void>;
}

export interface AssetRelation {
	relationId: string;
	fromAssetId: string;
	toAssetId: string;
	type: string;
}

/** Persistence boundary for relationships keyed by stable asset UUIDs. */
export interface GraphStore {
	open(paths: LibraryPaths): Promise<void>;
	close(): Promise<void>;
	upsertRelation(relation: AssetRelation): Promise<void>;
	listRelations(assetId: string): Promise<AssetRelation[]>;
	removeRelation(relationId: string): Promise<void>;
}
