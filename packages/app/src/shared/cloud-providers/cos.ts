export interface CosCloudConfig {
	provider: "cos";
	bucket: string;
	region: string;
}
export interface CosCloudCredentials { secretId: string; secretKey: string }
export type CosCloudConfigDraft = CosCloudConfig & { credentials?: CosCloudCredentials };
export type CosCloudConnection = CosCloudConfig & { credentials: CosCloudCredentials };

export const DEFAULT_COS_CONFIG: CosCloudConfig = { provider: "cos", bucket: "", region: "ap-shanghai" };
