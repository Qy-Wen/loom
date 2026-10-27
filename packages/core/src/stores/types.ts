import type { Asset } from "../model/asset.ts";
import type { AssetRelation } from "../model/relation.ts";
import type { AssetTag, Tag } from "../model/tag.ts";
import type { AssetEnrichment } from "../model/enrichment.ts";
import type { AssetPropertyValue, PropertyDefinition } from "../model/property.ts";
import type { LibraryPaths } from "../library/paths.ts";
import type { ImageVlmRecord } from "../model/image-vlm.ts";
import type { VideoVlmRecord } from "../model/video-vlm.ts";
import type { AudioWriteupRecord } from "../model/audio-writeup.ts";
import type { NearestChildHit } from "../model/hybrid.ts";
import type {
	StoredTextChunk,
	TextEmbedJob,
} from "../model/text-embed.ts";

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
	listFavoriteIds(): Promise<string[]>;
	setFavorite(assetId: string, favorite: boolean): Promise<void>;
	listTags(): Promise<Tag[]>;
	listAssetTags(): Promise<AssetTag[]>;
	addAssetTag(assetId: string, name: string): Promise<void>;
	removeAssetTag(assetId: string, tagId: string): Promise<void>;
	getLibraryVolumeId(): Promise<string | undefined>;
	setLibraryVolumeId(volumeId: string): Promise<void>;

	createProperty(property: PropertyDefinition): Promise<void>;
	updateProperty(property: PropertyDefinition): Promise<void>;
	getProperty(propertyId: string): Promise<PropertyDefinition | undefined>;
	listProperties(): Promise<PropertyDefinition[]>;
	removeProperty(propertyId: string): Promise<void>;
	setAssetProperty(value: AssetPropertyValue): Promise<void>;
	listAssetProperties(assetId: string): Promise<AssetPropertyValue[]>;
	listAllAssetProperties(): Promise<AssetPropertyValue[]>;
	removeAssetProperty(assetId: string, propertyId: string): Promise<void>;
	getAssetEnrichment(assetId: string): Promise<AssetEnrichment | undefined>;
	listAssetEnrichments(): Promise<AssetEnrichment[]>;
	/** Recover jobs left running by a previous opening; call before admitting new jobs. */
	recoverInterruptedJobs(): Promise<void>;
	upsertAssetEnrichment(record: AssetEnrichment): Promise<void>;
	getTextEmbedJob(assetId: string): Promise<TextEmbedJob | undefined>;
	upsertTextEmbedJob(job: TextEmbedJob): Promise<void>;
	replaceTextChunks(assetId: string, chunks: StoredTextChunk[]): Promise<void>;
	listTextChunks(assetId: string): Promise<StoredTextChunk[]>;
	getImageVlm(assetId: string): Promise<ImageVlmRecord | undefined>;
	upsertImageVlm(record: ImageVlmRecord): Promise<void>;
	getVideoVlm(assetId: string): Promise<VideoVlmRecord | undefined>;
	upsertVideoVlm(record: VideoVlmRecord): Promise<void>;
	getAudioWriteup(assetId: string): Promise<AudioWriteupRecord | undefined>;
	upsertAudioWriteup(record: AudioWriteupRecord): Promise<void>;
	searchAssetIds(query: string): Promise<string[]>;
	searchNearestChildren(vector: number[], limit: number): Promise<NearestChildHit[]>;
}

/** Ladybug table for every edge. Not a user-facing type. */
export const RELATED = "RELATED";

const MAX_RELATION_TYPE_LENGTH = 64;

/** Trim and reject empty labels. `RELATED` is the storage table, not a type name. */
export function normalizeRelationType(type: string): string {
	const value = type.trim();
	if (!value) throw new Error("Relationship type is required");
	if (value.length > MAX_RELATION_TYPE_LENGTH) throw new Error("Relationship type is too long");
	if (value.toUpperCase() === RELATED) throw new Error("RELATED is reserved");
	return value;
}

/** Persistence boundary for relationships keyed by stable asset UUIDs. */
export interface GraphStore {
	open(paths: LibraryPaths): Promise<void>;
	close(): Promise<void>;
	ensureAsset(assetId: string): Promise<void>;
	removeAsset(assetId: string): Promise<void>;
	upsertRelation(relation: AssetRelation): Promise<void>;
	listRelations(assetId: string): Promise<AssetRelation[]>;
	listAllRelations(): Promise<AssetRelation[]>;
	removeRelation(relationId: string): Promise<void>;
}
