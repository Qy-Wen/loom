import type { Asset, AssetType } from "./asset.ts";
import type { AssetEnrichment } from "./enrichment.ts";
import type { PropertyType, PropertyValue } from "./property.ts";
import type { ImageVlmStatus } from "./image-vlm.ts";
import type { TextEmbedStatus } from "./text-embed.ts";
import type { VideoVlmStatus } from "./video-vlm.ts";
import type { AudioWriteupStatus } from "./audio-writeup.ts";

export type PropertyFilterOperator = "eq" | "contains" | "gte" | "lte";

export interface AssetPropertyFilter {
	/** Case-insensitive property definition name. */
	name: string;
	operator: PropertyFilterOperator;
	value: PropertyValue;
}

export interface AssetSearchQuery {
	query?: string;
	type?: AssetType;
	properties?: AssetPropertyFilter[];
	/** Tag names, case-insensitive. A file must have every one. An unknown tag matches nothing. */
	tags?: string[];
	/** true keeps favorites only; false keeps files that are not favorites. */
	favorite?: boolean;
	limit?: number;
}

export interface AssetPropertyView {
	propertyId: string;
	name: string;
	type: PropertyType;
	value: PropertyValue;
}

/** Safe asset shape for Agent/UI consumers: never contains an absolute path. */
export interface AssetSearchItem {
	assetId: string;
	filename: string;
	relativePath: string;
	type: AssetType;
	size: number;
	modifiedAt: number;
	properties: AssetPropertyView[];
	passage?: string;
	parentPassage?: string;
	chunkId?: string;
	score?: number;
}

export interface AssetSearchResult {
	kind: "asset_list";
	assets: AssetSearchItem[];
	total: number;
}

export interface DeepSearchResult extends AssetSearchResult {
	/**
	 * Files in the library that have an index. Deep search only sees these, so when
	 * it is 0 or small the caller should use simple search or index files first.
	 */
	indexedCount: number;
}

export interface AssetRelationView {
	assetId: string;
	filename: string;
	relativePath: string;
	type: AssetType;
}

/** One edge touching the inspected asset. `direction` is from that asset's side. */
export interface AssetLinkView {
	relationId: string;
	relationType: string;
	direction: "out" | "in";
	asset: AssetRelationView;
}

export interface AssetRelationsResult {
	links: AssetLinkView[];
}

export interface AssetDetailResult extends AssetSearchItem, AssetRelationsResult {
	kind: "asset_detail";
	createdAt: number;
	/** Tag names on this file, in the order they were added. */
	tags: string[];
	favorite: boolean;
	/** Renderer-safe reference resolved by Electron Main through asset UUID. */
	previewRef: string;
	enrichment?: AssetEnrichment;
	textEmbed: TextEmbedStatus;
	imageVlm: ImageVlmStatus;
	videoVlm: VideoVlmStatus;
	audioWriteup: AudioWriteupStatus;
}

export function toSearchItem(asset: Asset, properties: AssetPropertyView[]): AssetSearchItem {
	return {
		assetId: asset.assetId,
		filename: asset.filename,
		relativePath: asset.relativePath,
		type: asset.type,
		size: asset.size,
		modifiedAt: asset.modifiedAt,
		properties,
	};
}
