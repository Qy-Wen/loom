export type DescriptionJobStatus = "describing" | "ready" | "failed";
export type DescriptionStatusKind = "idle" | DescriptionJobStatus;

export interface DescriptionRecord {
	assetId: string;
	status: DescriptionJobStatus;
	modelId?: string;
	sourceModifiedAt: number;
	error?: string;
	markdown?: string;
	updatedAt: number;
}

export interface DescriptionStatus {
	assetId: string;
	status: DescriptionStatusKind;
	stale: boolean;
	supported: boolean;
	modelId?: string;
	sourceModifiedAt?: number;
	error?: string;
	markdown?: string;
}
