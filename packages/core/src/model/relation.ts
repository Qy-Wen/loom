/** A directed relationship between stable asset IDs. */
export interface AssetRelation {
	relationId: string;
	fromAssetId: string;
	toAssetId: string;
	type: string;
}
