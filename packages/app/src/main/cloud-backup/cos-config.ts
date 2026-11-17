import type { CosCloudConfig, CosCloudCredentials } from "../../shared/cloud-providers/cos.ts";

export function parseCosConfig(input: Record<string, unknown>): CosCloudConfig {
	const { bucket, region } = input;
	if (typeof bucket !== "string" || !/^[a-z0-9][a-z0-9-]{0,61}-\d+$/.test(bucket.trim())) throw new Error("Enter the full COS bucket name, including APPID");
	if (typeof region !== "string" || !/^[a-z]{2}-[a-z0-9-]+$/.test(region.trim())) throw new Error("Invalid COS region");
	return { provider: "cos", bucket: bucket.trim(), region: region.trim() };
}

/** An omitted/blank pair keeps the saved credentials for this provider. Partial pairs are errors. */
export function parseCosCredentialDraft(input: unknown): CosCloudCredentials | undefined {
	if (input === undefined) return undefined;
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid COS credentials");
	const { secretId, secretKey } = input as Record<string, unknown>;
	if (typeof secretId !== "string" || typeof secretKey !== "string") throw new Error("Enter both SecretId and SecretKey");
	if (!secretId.trim() && !secretKey.trim()) return undefined;
	if (!secretId.trim() || !secretKey.trim()) throw new Error("Enter both SecretId and SecretKey");
	return { secretId: secretId.trim(), secretKey: secretKey.trim() };
}

export function parseCosCredentials(input: unknown): CosCloudCredentials {
	const credentials = parseCosCredentialDraft(input);
	if (!credentials) throw new Error("Enter SecretId and SecretKey");
	return credentials;
}
