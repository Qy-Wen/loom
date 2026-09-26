/** Typed contract shared by Electron main, preload, and renderer. */
import type {
	Asset,
	AssetType,
	AssetEnrichment,
	AssetPropertyValue,
	AssetRelation,
	AssetRelationsResult,
	LibraryChange,
	LibrarySnapshot,
	PropertyDefinition,
	PropertySnapshot,
	PropertyType,
	PropertyValue,
	SessionRecord,
	SessionSummary,
	TextEmbedStatus,
	ImageVlmStatus,
} from "@loom/core";
import type { AgentStatsView } from "./agent-stats.ts";
import type { McpServerDraft, McpServerStatus, McpSettingsView } from "./mcp-settings.ts";
import type { ModelProbeDraft, ModelSettingsDraft, ModelSettingsView, ProbeResult } from "./model-settings.ts";

export type AssetContextAction =
	| "rename"
	| "duplicate"
	| "copy"
	| "paste"
	| "new_folder"
	| "copy_path"
	| "reveal"
	| "trash";
export type FolderContextAction =
	| "rename"
	| "copy"
	| "paste"
	| "new_folder"
	| "copy_path"
	| "reveal"
	| "trash";
export type LibraryContextAction = "paste" | "new_folder" | "new_md_file";

export interface AgentEndpoint {
	runtimeUrl: string;
	agentId: string;
}

export interface UiSelectionDraft {
	assetId: string;
	path: string;
	assetType: AssetType;
}

export const IPC = {
	getAgentEndpoint: "loom:getAgentEndpoint",
	openLibrary: "loom:openLibrary",
	getLibrarySnapshot: "loom:getLibrarySnapshot",
	libraryChanged: "loom:libraryChanged",
	showAssetContextMenu: "loom:showAssetContextMenu",
	showFolderContextMenu: "loom:showFolderContextMenu",
	showLibraryContextMenu: "loom:showLibraryContextMenu",
	renameAsset: "loom:renameAsset",
	duplicateAsset: "loom:duplicateAsset",
	copyAssetsInto: "loom:copyAssetsInto",
	createFolder: "loom:createFolder",
	createMarkdownFile: "loom:createMarkdownFile",
	renameFolder: "loom:renameFolder",
	copyFolderInto: "loom:copyFolderInto",
	copyAssetPath: "loom:copyAssetPath",
	copyFolderPath: "loom:copyFolderPath",
	revealAsset: "loom:revealAsset",
	revealFolder: "loom:revealFolder",
	trashAsset: "loom:trashAsset",
	trashFolder: "loom:trashFolder",
	getPropertySnapshot: "loom:getPropertySnapshot",
	createProperty: "loom:createProperty",
	updateProperty: "loom:updateProperty",
	removeProperty: "loom:removeProperty",
	setAssetProperty: "loom:setAssetProperty",
	removeAssetProperty: "loom:removeAssetProperty",
	getAssetEnrichment: "loom:getAssetEnrichment",
	getAssetRelations: "loom:getAssetRelations",
	listGraphRelations: "loom:listGraphRelations",
	createRelation: "loom:createRelation",
	removeRelation: "loom:removeRelation",
	analyzeAsset: "loom:analyzeAsset",
	getTextEmbedStatus: "loom:getTextEmbedStatus",
	embedAsset: "loom:embedAsset",
	getImageVlmStatus: "loom:getImageVlmStatus",
	describeImage: "loom:describeImage",
	listSessions: "loom:listSessions",
	createSession: "loom:createSession",
	openSession: "loom:openSession",
	getSession: "loom:getSession",
	archiveSession: "loom:archiveSession",
	unarchiveSession: "loom:unarchiveSession",
	deleteSession: "loom:deleteSession",
	sessionsChanged: "loom:sessionsChanged",
	getModelSettings: "loom:getModelSettings",
	saveModelSettings: "loom:saveModelSettings",
	probeModelSlot: "loom:probeModelSlot",
	getMcpSettings: "loom:getMcpSettings",
	saveMcpSettings: "loom:saveMcpSettings",
	setMcpServerLive: "loom:setMcpServerLive",
	getAgentStats: "loom:getAgentStats",
	resetAgentStats: "loom:resetAgentStats",
	setUiSelection: "loom:setUiSelection",
} as const;

export interface LoomApi {
	getAgentEndpoint: () => Promise<AgentEndpoint>;
	openLibrary: () => Promise<LibrarySnapshot | null>;
	getLibrarySnapshot: () => Promise<LibrarySnapshot>;
	onLibraryChanged: (listener: (change: LibraryChange) => void) => () => void;
	showAssetContextMenu: (assetId: string, canPaste: boolean) => Promise<AssetContextAction | null>;
	showFolderContextMenu: (relativePath: string, canPaste: boolean) => Promise<FolderContextAction | null>;
	showLibraryContextMenu: (canPaste: boolean) => Promise<LibraryContextAction | null>;
	renameAsset: (assetId: string, stem: string) => Promise<Asset>;
	duplicateAsset: (assetId: string) => Promise<Asset>;
	copyAssetsInto: (assetIds: string[], destFolder: string) => Promise<Asset[]>;
	createFolder: (parentRelativePath: string) => Promise<string>;
	createMarkdownFile: (parentRelativePath: string) => Promise<Asset>;
	renameFolder: (relativePath: string, name: string) => Promise<string>;
	copyFolderInto: (sourceFolder: string, destFolder: string) => Promise<string>;
	copyAssetPath: (assetId: string) => Promise<void>;
	copyFolderPath: (relativePath: string) => Promise<void>;
	revealAsset: (assetId: string) => Promise<void>;
	revealFolder: (relativePath: string) => Promise<void>;
	trashAsset: (assetId: string) => Promise<boolean>;
	trashFolder: (relativePath: string) => Promise<boolean>;
	getPropertySnapshot: () => Promise<PropertySnapshot>;
	createProperty: (name: string, type: PropertyType) => Promise<PropertyDefinition>;
	updateProperty: (propertyId: string, name: string, type: PropertyType) => Promise<PropertyDefinition>;
	removeProperty: (propertyId: string) => Promise<void>;
	setAssetProperty: (
		assetId: string,
		propertyId: string,
		value: PropertyValue,
	) => Promise<AssetPropertyValue>;
	removeAssetProperty: (assetId: string, propertyId: string) => Promise<void>;
	getAssetEnrichment: (assetId: string) => Promise<AssetEnrichment | undefined>;
	getAssetRelations: (assetId: string) => Promise<AssetRelationsResult>;
	listGraphRelations: () => Promise<AssetRelation[]>;
	createRelation: (fromAssetId: string, toAssetId: string, type: string) => Promise<AssetRelation>;
	removeRelation: (relationId: string) => Promise<void>;
	analyzeAsset: (assetId: string) => Promise<AssetEnrichment>;
	getTextEmbedStatus: (assetId: string) => Promise<TextEmbedStatus>;
	embedAsset: (assetId: string) => Promise<TextEmbedStatus>;
	getImageVlmStatus: (assetId: string) => Promise<ImageVlmStatus>;
	describeImage: (assetId: string) => Promise<ImageVlmStatus>;
	listSessions: () => Promise<SessionSummary[]>;
	createSession: () => Promise<SessionRecord>;
	openSession: (id: string) => Promise<SessionRecord>;
	getSession: (id: string) => Promise<SessionRecord>;
	archiveSession: (id: string) => Promise<void>;
	unarchiveSession: (id: string) => Promise<void>;
	deleteSession: (id: string) => Promise<void>;
	onSessionsChanged: (listener: (sessions: SessionSummary[]) => void) => () => void;
	getModelSettings: () => Promise<ModelSettingsView>;
	saveModelSettings: (draft: ModelSettingsDraft) => Promise<ModelSettingsView>;
	probeModelSlot: (draft: ModelProbeDraft) => Promise<ProbeResult>;
	getMcpSettings: () => Promise<McpSettingsView>;
	saveMcpSettings: (servers: McpServerDraft[]) => Promise<McpSettingsView>;
	setMcpServerLive: (server: McpServerDraft) => Promise<McpServerStatus>;
	getAgentStats: () => Promise<AgentStatsView>;
	resetAgentStats: () => Promise<AgentStatsView>;
	setUiSelection: (selection: UiSelectionDraft | null) => Promise<void>;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
