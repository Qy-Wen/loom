export const ENRICHMENT_VERSION = 1;
export const TEXT_ENRICHMENT_LIMIT = 256 * 1024;

export type EnrichmentStatus = "ready" | "failed" | "skipped";

export type ImageEnrichmentData = {
	kind: "image";
	width: number;
	height: number;
	orientation?: number;
	camera?: string;
	capturedAt?: string;
};

export type VideoEnrichmentData = {
	kind: "video";
	duration: number;
	width?: number;
	height?: number;
	videoCodec?: string;
	audioCodec?: string;
	frameRate?: number;
};

export type AudioEnrichmentData = {
	kind: "audio";
	duration: number;
	audioCodec?: string;
};

export type TextEnrichmentData = {
	kind: "text";
	text: string;
	truncated: boolean;
	charCount: number;
};

export type EnrichmentData =
	| ImageEnrichmentData
	| VideoEnrichmentData
	| AudioEnrichmentData
	| TextEnrichmentData;

export interface AssetEnrichment {
	assetId: string;
	version: number;
	sourceModifiedAt: number;
	status: EnrichmentStatus;
	error?: string;
	data?: EnrichmentData;
}

export function isEnrichmentStale(record: AssetEnrichment | undefined, sourceModifiedAt: number): boolean {
	if (!record) return true;
	if (record.version !== ENRICHMENT_VERSION) return true;
	return record.sourceModifiedAt !== sourceModifiedAt;
}
