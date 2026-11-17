import { DEFAULT_COS_CONFIG, type CosCloudConfig, type CosCloudConfigDraft } from "./cloud-providers/cos.ts";

/** Add each supported provider to these discriminated unions and the provider registries. */
export type DisabledCloudConfig = { provider: "none" };
export type ActiveCloudConfig = CosCloudConfig;
export type CloudConfig = DisabledCloudConfig | ActiveCloudConfig;
export type CloudConfigDraft = DisabledCloudConfig | CosCloudConfigDraft;
export type CloudProviderId = CloudConfig["provider"];
export const CLOUD_PROVIDER_IDS = ["none", "cos"] as const satisfies readonly CloudProviderId[];

export function unsupportedCloudProvider(_provider: never): never { throw new Error("Unsupported cloud provider"); }

export function defaultCloudConfig(provider: CloudProviderId = CLOUD_PROVIDER_IDS[0]): CloudConfig {
	switch (provider) {
		case "none": return { provider: "none" };
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
export interface CloudFileChange {
	path: string;
	kind: "added" | "modified" | "deleted";
	type: "file" | "directory";
	size: number;
}
export interface CloudPreview {
	checkedAt: string;
	stale: boolean;
	repair: boolean;
	uploadBytes: number;
	changes: CloudFileChange[];
}
export type CloudPullChoice = "local" | "remote";
export interface CloudPullChange {
	id: string;
	path: string;
	type: "file" | "directory" | "metadata";
	conflict: boolean;
	choice?: CloudPullChoice;
	localExists: boolean;
	remoteExists: boolean;
	localBytes: number;
	remoteBytes: number;
	downloadBytes: number;
}
export interface CloudPullPreview {
	id: string;
	libraryId: string;
	rootPath: string;
	checkedAt: string;
	changes: CloudPullChange[];
	firstSync: boolean;
}
export interface LocalCloudLibrary {
	rootPath: string;
	libraryId?: string;
	libraryName: string;
	status: "never" | "unchecked" | "changed" | "current" | "checking" | "failed";
	lastBackupAt?: string;
	preview?: CloudPreview;
	error?: string;
	retryOperation?: "backup" | "preview";
}
export type BackupPhase = "snapshot" | "upload" | "delete" | "download" | "verify" | "list" | "test" | "conflicts" | "apply";
export interface CloudJob {
	operation: "backup" | "preview" | "restore" | "list" | "test" | "pull";
	rootPath?: string;
	libraryId?: string;
	status: "running" | "completed" | "failed" | "cancelled";
	phase: BackupPhase;
	completedFiles: number;
	totalFiles: number;
	completedBytes: number;
	totalBytes: number;
	/** File payload progress excludes request overhead/retransmissions; completedBytes also includes skipped files. */
	uploadedBytes?: number;
	skippedFiles?: number;
	currentFile?: string;
	error?: string;
	restoredPath?: string;
}
export interface CloudBackupView {
	config: CloudConfig;
	hasCredentials: boolean;
	libraries: CloudLibrary[];
	localLibrary?: LocalCloudLibrary;
	job?: CloudJob;
	pull?: CloudPullPreview;
}
