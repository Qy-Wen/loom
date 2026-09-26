export interface NearestChildHit {
	chunkId: string;
	assetId: string;
	parentId: string | null;
	text: string;
	parentText?: string;
}
