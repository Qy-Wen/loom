import { DEFAULT_COS_CONFIG, type CosCloudConfig, type CosCloudConfigDraft } from "./cloud-providers/cos.ts";

/** Add each supported provider to these discriminated unions and the provider registries. */
export type CloudConfig = CosCloudConfig;
export type CloudConfigDraft = CosCloudConfigDraft;
export type CloudProviderId = CloudConfig["provider"];
export const CLOUD_PROVIDER_IDS = ["cos"] as const satisfies readonly CloudProviderId[];

export function unsupportedCloudProvider(_provider: never): never { throw new Error("Unsupported cloud provider"); }

export function defaultCloudConfig(provider: CloudProviderId = CLOUD_PROVIDER_IDS[0]): CloudConfig {
	switch (provider) {
		case "cos": return { ...DEFAULT_COS_CONFIG };
		default: return unsupportedCloudProvider(provider);
	}
}
export interface CloudLibrary {
	format: 1;
	libraryId: string;
	libraryName: string;
	updatedAt: string;
	deviceName: string;
	fileCount: number;
	totalBytes: number;
	state: "updating" | "ready";
	/** Identifies the current update for integrity checks, without retaining history. */
	revision: string;
	manifestHash?: string;
}
export type BackupPhase = "snapshot" | "upload" | "delete" | "download" | "verify" | "list" | "test";
export interface CloudJob {
	operation: "backup" | "restore" | "list" | "test";
	status: "running" | "completed" | "failed" | "cancelled";
	phase: BackupPhase;
	completedFiles: number;
	totalFiles: number;
	completedBytes: number;
	totalBytes: number;
	currentFile?: string;
	error?: string;
	restoredPath?: string;
}
export interface CloudBackupView {
	config: CloudConfig;
	hasCredentials: boolean;
	libraries: CloudLibrary[];
	job?: CloudJob;
}
