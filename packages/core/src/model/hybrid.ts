/** A child chunk found by vector or full-text search, with its parent for context. */
export interface ChunkHit {
	chunkId: string;
	assetId: string;
	parentId: string | null;
	text: string;
	parentText?: string;
}
