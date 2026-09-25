/** Typed contract shared by Electron main, preload, and renderer. */
import type {
	Asset,
	AssetEnrichment,
	AssetPropertyValue,
	AssetRelationsResult,
	LibraryChange,
	LibrarySnapshot,
	PropertyDefinition,
	PropertySnapshot,
	PropertyType,
	PropertyValue,
	SessionRecord,
	SessionSummary,
} from "@loom/core";

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
	getPropertySnapshot: "loom:getPropertySnapshot",
	createProperty: "loom:createProperty",
	updateProperty: "loom:updateProperty",
	removeProperty: "loom:removeProperty",
	setAssetProperty: "loom:setAssetProperty",
	removeAssetProperty: "loom:removeAssetProperty",
	getAssetEnrichment: "loom:getAssetEnrichment",
	getAssetRelations: "loom:getAssetRelations",
	analyzeAsset: "loom:analyzeAsset",
	listSessions: "loom:listSessions",
	createSession: "loom:createSession",
	openSession: "loom:openSession",
	getSession: "loom:getSession",
	archiveSession: "loom:archiveSession",
	unarchiveSession: "loom:unarchiveSession",
	deleteSession: "loom:deleteSession",
	sessionsChanged: "loom:sessionsChanged",
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
	analyzeAsset: (assetId: string) => Promise<AssetEnrichment>;
	listSessions: () => Promise<SessionSummary[]>;
	createSession: () => Promise<SessionRecord>;
	openSession: (id: string) => Promise<SessionRecord>;
	getSession: (id: string) => Promise<SessionRecord>;
	archiveSession: (id: string) => Promise<void>;
	unarchiveSession: (id: string) => Promise<void>;
	deleteSession: (id: string) => Promise<void>;
	onSessionsChanged: (listener: (sessions: SessionSummary[]) => void) => () => void;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
