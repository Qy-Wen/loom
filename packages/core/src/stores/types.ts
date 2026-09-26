import type { Asset } from "../model/asset.ts";
import type { AssetEnrichment } from "../model/enrichment.ts";
import type { AssetPropertyValue, PropertyDefinition } from "../model/property.ts";
import type { LibraryPaths } from "../library/paths.ts";
import type { ImageVlmRecord } from "../model/image-vlm.ts";
import type { VideoVlmRecord } from "../model/video-vlm.ts";
import type {
	ChildEmbeddingUpdate,
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
	upsertAssetEnrichment(record: AssetEnrichment): Promise<void>;
	getTextEmbedJob(assetId: string): Promise<TextEmbedJob | undefined>;
	upsertTextEmbedJob(job: TextEmbedJob): Promise<void>;
	replaceTextChunks(assetId: string, chunks: StoredTextChunk[]): Promise<void>;
	listTextChunks(assetId: string): Promise<StoredTextChunk[]>;
	updateChildEmbeddings(assetId: string, updates: ChildEmbeddingUpdate[]): Promise<void>;
	getImageVlm(assetId: string): Promise<ImageVlmRecord | undefined>;
	upsertImageVlm(record: ImageVlmRecord): Promise<void>;
	getVideoVlm(assetId: string): Promise<VideoVlmRecord | undefined>;
	upsertVideoVlm(record: VideoVlmRecord): Promise<void>;
	searchAssetIds(query: string): Promise<string[]>;
}

/** Output → source. `fromAssetId` is the generated file. */
export const GENERATED_FROM = "GENERATED_FROM";

/** Ladybug table for user-defined edge labels. Not a user-facing type. */
export const RELATED = "RELATED";

const MAX_RELATION_TYPE_LENGTH = 64;

/** Trim and reject empty / reserved labels. `GENERATED_FROM` stays FFmpeg-only. */
export function normalizeRelationType(type: string): string {
	const value = type.trim();
	if (!value) throw new Error("Relationship type is required");
	if (value.length > MAX_RELATION_TYPE_LENGTH) throw new Error("Relationship type is too long");
	const reserved = value.toUpperCase();
	if (reserved === GENERATED_FROM) {
		throw new Error("GENERATED_FROM is reserved for FFmpeg provenance");
	}
	if (reserved === RELATED) throw new Error("RELATED is reserved");
	return value;
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
	ensureAsset(assetId: string): Promise<void>;
	removeAsset(assetId: string): Promise<void>;
	upsertRelation(relation: AssetRelation): Promise<void>;
	listRelations(assetId: string): Promise<AssetRelation[]>;
	listAllRelations(): Promise<AssetRelation[]>;
	removeRelation(relationId: string): Promise<void>;
}
