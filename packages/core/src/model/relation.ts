/** Where an edge came from. `manual` is user-made; the others are derived from file contents. */
export type RelationSource = "manual" | "markdown" | "canvas";

/** Sources that are re-derived from files and can only be removed by editing the source file. */
export type ReferenceSource = Exclude<RelationSource, "manual">;

/** Relation type shown for every derived reference. */
export const REFERENCE_TYPE = "reference";

/** A directed relationship between stable asset IDs. */
export interface AssetRelation {
	relationId: string;
	fromAssetId: string;
	toAssetId: string;
	type: string;
	source: RelationSource;
}

/** One file has at most one reference edge to a target, however often it links there. */
export function referenceRelationId(fromAssetId: string, toAssetId: string): string {
	return `reference:${fromAssetId}:${toAssetId}`;
}

export function isReferenceRelationId(relationId: string): boolean {
	return relationId.startsWith("reference:");
}
