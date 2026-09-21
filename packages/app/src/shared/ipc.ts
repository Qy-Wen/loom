/** Typed contract shared by Electron main, preload, and renderer. */
import type { Asset, LibraryChange, LibrarySnapshot } from "@loom/core";

export type AssetContextAction = "rename" | "duplicate" | "copy_path" | "reveal" | "trash";

export interface AgentEndpoint {
	runtimeUrl: string;
	agentId: string;
}

export const IPC = {
	getAgentEndpoint: "loom:getAgentEndpoint",
	openLibrary: "loom:openLibrary",
	getLibrarySnapshot: "loom:getLibrarySnapshot",
	libraryChanged: "loom:libraryChanged",
	showAssetContextMenu: "loom:showAssetContextMenu",
	renameAsset: "loom:renameAsset",
	duplicateAsset: "loom:duplicateAsset",
	copyAssetPath: "loom:copyAssetPath",
	revealAsset: "loom:revealAsset",
	trashAsset: "loom:trashAsset",
} as const;

export interface LoomApi {
	getAgentEndpoint: () => Promise<AgentEndpoint>;
	openLibrary: () => Promise<LibrarySnapshot | null>;
	getLibrarySnapshot: () => Promise<LibrarySnapshot>;
	onLibraryChanged: (listener: (change: LibraryChange) => void) => () => void;
	showAssetContextMenu: (assetId: string) => Promise<AssetContextAction | null>;
	renameAsset: (assetId: string, stem: string) => Promise<Asset>;
	duplicateAsset: (assetId: string) => Promise<Asset>;
	copyAssetPath: (assetId: string) => Promise<void>;
	revealAsset: (assetId: string) => Promise<void>;
	trashAsset: (assetId: string) => Promise<boolean>;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
