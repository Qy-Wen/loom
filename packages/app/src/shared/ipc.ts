/** Typed contract shared by Electron main, preload, and renderer. */
import type { ProcessSandboxNotice } from "./agent-sandbox.ts";
import type { ImageGrade, ImageGradeRecord } from "@loom/core/grade";
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
	TextEmbedStatus,
	ImageVlmStatus,
	VideoVlmStatus,
	AudioWriteupStatus,
} from "@loom/core";
import type {
	AgentPermissionLevel,
	CommandAllow,
	CommandAllowView,
	LoomSessionRecord as SessionRecord,
	LoomSessionSummary as SessionSummary,
	ToolGateDecision,
} from "@loom/agent";
import type { AgentStatsView } from "./agent-stats.ts";
import type { McpServerDraft, McpServerStatus, McpSettingsView } from "./mcp-settings.ts";
import type { GeneralSettings } from "./general-settings.ts";
import type { ModelProbeDraft, ModelSettingsDraft, ModelSettingsView, ProbeResult } from "./model-settings.ts";

export type AssetContextAction =
	| "add_to_chat"
	| "favorite"
	| "unfavorite"
	| "rename"
	| "duplicate"
	| "cut"
	| "copy"
	| "paste"
	| "new_folder"
	| "copy_path"
	| "reveal"
	| "trash";
export type FolderContextAction =
	| "rename"
	| "cut"
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
	setFavorite: "loom:setFavorite",
	addAssetTag: "loom:addAssetTag",
	removeAssetTag: "loom:removeAssetTag",
	libraryChanged: "loom:libraryChanged",
	trashStarted: "loom:trashStarted",
	showAssetContextMenu: "loom:showAssetContextMenu",
	showFolderContextMenu: "loom:showFolderContextMenu",
	showLibraryContextMenu: "loom:showLibraryContextMenu",
	renameAsset: "loom:renameAsset",
	duplicateAsset: "loom:duplicateAsset",
	copyAssetsInto: "loom:copyAssetsInto",
	moveAssetsInto: "loom:moveAssetsInto",
	createFolder: "loom:createFolder",
	createMarkdownFile: "loom:createMarkdownFile",
	renameFolder: "loom:renameFolder",
	copyFolderInto: "loom:copyFolderInto",
	moveFolderInto: "loom:moveFolderInto",
	copyAssetPath: "loom:copyAssetPath",
	copyFolderPath: "loom:copyFolderPath",
	revealAsset: "loom:revealAsset",
	revealFolder: "loom:revealFolder",
	trashAsset: "loom:trashAsset",
	trashFolder: "loom:trashFolder",
	trashLibraryItems: "loom:trashLibraryItems",
	copyLibraryPaths: "loom:copyLibraryPaths",
	readFileClipboard: "loom:readFileClipboard",
	placePathsInto: "loom:placePathsInto",
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
	getVideoVlmStatus: "loom:getVideoVlmStatus",
	describeVideo: "loom:describeVideo",
	getAudioWriteupStatus: "loom:getAudioWriteupStatus",
	describeAudio: "loom:describeAudio",
	listSessions: "loom:listSessions",
	createSession: "loom:createSession",
	openSession: "loom:openSession",
	getSession: "loom:getSession",
	stageComposerImages: "loom:stageComposerImages",
	stageComposerAssets: "loom:stageComposerAssets",
	pickComposerLibraryAssets: "loom:pickComposerLibraryAssets",
	importComposerFiles: "loom:importComposerFiles",
	pickComposerExternalFiles: "loom:pickComposerExternalFiles",
	followUp: "loom:followUp",
	branchBefore: "loom:branchBefore",
	forkBefore: "loom:forkBefore",
	archiveSession: "loom:archiveSession",
	unarchiveSession: "loom:unarchiveSession",
	deleteSession: "loom:deleteSession",
	sessionsChanged: "loom:sessionsChanged",
	settingsChanged: "loom:settingsChanged",
	processSandboxDisabled: "loom:processSandboxDisabled",
	getProcessSandboxNotice: "loom:getProcessSandboxNotice",
	acknowledgeProcessSandboxNotice: "loom:acknowledgeProcessSandboxNotice",
	getModelSettings: "loom:getModelSettings",
	saveModelSettings: "loom:saveModelSettings",
	probeModelSlot: "loom:probeModelSlot",
	getMcpSettings: "loom:getMcpSettings",
	saveMcpSettings: "loom:saveMcpSettings",
	setMcpServerLive: "loom:setMcpServerLive",
	getAgentInstructions: "loom:getAgentInstructions",
	saveAgentInstructions: "loom:saveAgentInstructions",
	getGeneralSettings: "loom:getGeneralSettings",
	saveGeneralSettings: "loom:saveGeneralSettings",
	getAgentSandbox: "loom:getAgentSandbox",
	saveAgentSandbox: "loom:saveAgentSandbox",
	getAgentStats: "loom:getAgentStats",
	resetAgentStats: "loom:resetAgentStats",
	setUiSelection: "loom:setUiSelection",
	getAgentPermission: "loom:getAgentPermission",
	setAgentPermission: "loom:setAgentPermission",
	resolveToolGate: "loom:resolveToolGate",
	getCommandAllows: "loom:getCommandAllows",
	removeCommandAllow: "loom:removeCommandAllow",
	commandAllowsChanged: "loom:commandAllowsChanged",
	getImageGrade: "loom:getImageGrade",
	previewImageGrade: "loom:previewImageGrade",
	saveImageGrade: "loom:saveImageGrade",
	getVideoGradeInfo: "loom:getVideoGradeInfo",
	previewVideoGrade: "loom:previewVideoGrade",
	saveVideoGrade: "loom:saveVideoGrade",
	pickGradeOutput: "loom:pickGradeOutput",
	pickGradeLut: "loom:pickGradeLut",
	isFullscreen: "loom:isFullscreen",
	fullscreenChanged: "loom:fullscreenChanged",
} as const;

export interface LoomApi {
	getAgentEndpoint: () => Promise<AgentEndpoint>;
	openLibrary: () => Promise<LibrarySnapshot | null>;
	getLibrarySnapshot: () => Promise<LibrarySnapshot>;
	setFavorite: (assetId: string, favorite: boolean) => Promise<void>;
	addAssetTag: (assetId: string, name: string) => Promise<void>;
	removeAssetTag: (assetId: string, tagId: string) => Promise<void>;
	onLibraryChanged: (listener: (change: LibraryChange) => void) => () => void;
	onTrashStarted: (listener: () => void) => () => void;
	showAssetContextMenu: (assetId: string, canPaste: boolean, single: boolean) => Promise<AssetContextAction | null>;
	showFolderContextMenu: (relativePath: string, canPaste: boolean, single: boolean) => Promise<FolderContextAction | null>;
	showLibraryContextMenu: (canPaste: boolean) => Promise<LibraryContextAction | null>;
	renameAsset: (assetId: string, stem: string) => Promise<Asset>;
	duplicateAsset: (assetId: string) => Promise<Asset>;
	copyAssetsInto: (assetIds: string[], destFolder: string) => Promise<Asset[]>;
	moveAssetsInto: (assetIds: string[], destFolder: string) => Promise<Asset[]>;
	createFolder: (parentRelativePath: string) => Promise<string>;
	createMarkdownFile: (parentRelativePath: string) => Promise<Asset>;
	renameFolder: (relativePath: string, name: string) => Promise<string>;
	copyFolderInto: (sourceFolder: string, destFolder: string) => Promise<string>;
	moveFolderInto: (sourceFolder: string, destFolder: string) => Promise<string>;
	copyAssetPath: (assetId: string) => Promise<void>;
	copyFolderPath: (relativePath: string) => Promise<void>;
	revealAsset: (assetId: string) => Promise<void>;
	revealFolder: (relativePath: string) => Promise<void>;
	trashAsset: (assetId: string) => Promise<boolean>;
	trashFolder: (relativePath: string) => Promise<boolean>;
	trashLibraryItems: (assetIds: string[], folders: string[]) => Promise<boolean>;
	copyLibraryPaths: (assetIds: string[], folders: string[]) => Promise<void>;
	readFileClipboard: () => Promise<{ paths: string[]; move: boolean } | null>;
	placePathsInto: (absolutePaths: string[], destFolder: string, move: boolean) => Promise<{ assets: Asset[]; folders: string[] }>;
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
	getVideoVlmStatus: (assetId: string) => Promise<VideoVlmStatus>;
	describeVideo: (assetId: string) => Promise<VideoVlmStatus>;
	getAudioWriteupStatus: (assetId: string) => Promise<AudioWriteupStatus>;
	describeAudio: (assetId: string) => Promise<AudioWriteupStatus>;
	listSessions: () => Promise<SessionSummary[]>;
	createSession: () => Promise<SessionRecord>;
	openSession: (id: string) => Promise<SessionRecord>;
	getSession: (id: string) => Promise<SessionRecord>;
	/** Hold composer images until the next prompt or follow-up on this session. */
	stageComposerImages: (id: string, images: Array<{ filename: string; mimeType: string; data: string }>) => Promise<void>;
	/** Hold composer library chips until the next prompt or follow-up on this session. */
	stageComposerAssets: (id: string, assets: Array<{ assetId: string; path: string; assetType: string }>) => Promise<void>;
	/** Open a file dialog inside the library and return indexed assets as composer chips. */
	pickComposerLibraryAssets: () => Promise<UiSelectionDraft[]>;
	/** Copy files into Inbox (or reuse if they are already in the library) and return composer chips. */
	importComposerFiles: (filePaths: string[]) => Promise<UiSelectionDraft[]>;
	/** Open a file dialog anywhere, import into Inbox, and return composer chips. */
	pickComposerExternalFiles: () => Promise<UiSelectionDraft[]>;
	pathForFile: (file: File) => string;
	/** Queue text into the active run. Inserted when that run would otherwise finish. */
	followUp: (id: string, text: string) => Promise<void>;
	/** Move the active path to just before this user question. */
	branchBefore: (id: string, entryId: string) => Promise<SessionRecord>;
	/** Open a new session from the prefix before this question. */
	forkBefore: (id: string, entryId: string) => Promise<SessionRecord>;
	archiveSession: (id: string) => Promise<void>;
	unarchiveSession: (id: string) => Promise<void>;
	deleteSession: (id: string) => Promise<void>;
	onSessionsChanged: (listener: (sessions: SessionSummary[]) => void) => () => void;
	onSettingsChanged: (listener: () => void) => () => void;
	onProcessSandboxDisabled: (listener: (notice: ProcessSandboxNotice) => void) => () => void;
	getProcessSandboxNotice: () => Promise<ProcessSandboxNotice | null>;
	acknowledgeProcessSandboxNotice: (id: string) => Promise<void>;
	getModelSettings: () => Promise<ModelSettingsView>;
	saveModelSettings: (draft: ModelSettingsDraft) => Promise<ModelSettingsView>;
	probeModelSlot: (draft: ModelProbeDraft) => Promise<ProbeResult>;
	getMcpSettings: () => Promise<McpSettingsView>;
	saveMcpSettings: (servers: McpServerDraft[]) => Promise<McpSettingsView>;
	setMcpServerLive: (server: McpServerDraft) => Promise<McpServerStatus>;
	getAgentInstructions: () => Promise<string>;
	saveAgentInstructions: (text: string) => Promise<string>;
	getGeneralSettings: () => Promise<GeneralSettings>;
	saveGeneralSettings: (settings: GeneralSettings) => Promise<GeneralSettings>;
	getAgentSandbox: () => Promise<boolean>;
	saveAgentSandbox: (enabled: boolean) => Promise<boolean>;
	getAgentStats: () => Promise<AgentStatsView>;
	resetAgentStats: () => Promise<AgentStatsView>;
	setUiSelection: (selection: UiSelectionDraft | null) => Promise<void>;
	getAgentPermission: () => Promise<AgentPermissionLevel>;
	setAgentPermission: (level: AgentPermissionLevel) => Promise<AgentPermissionLevel>;
	resolveToolGate: (toolCallId: string, decision: ToolGateDecision) => Promise<boolean>;
	getCommandAllows: () => Promise<CommandAllowView>;
	removeCommandAllow: (allow: CommandAllow) => Promise<CommandAllowView>;
	onCommandAllowsChanged: (listener: (view: CommandAllowView) => void) => () => void;
	getImageGrade: (assetId: string) => Promise<ImageGradeRecord | null>;
	/** JPEG bytes, base64. Null when the grade leaves the image unchanged. */
	previewImageGrade: (assetId: string, grade: ImageGrade, lut?: string, force?: boolean) => Promise<string | null>;
	saveImageGrade: (assetId: string, grade: ImageGrade, lut?: string, output?: string) => Promise<{ assetId: string; path: string }>;
	getVideoGradeInfo: (assetId: string) => Promise<{ duration: number }>;
	/** JPEG bytes of one graded frame, base64. Null when the grade leaves the frame unchanged. */
	previewVideoGrade: (assetId: string, timeSeconds: number, grade: ImageGrade, lut?: string, force?: boolean) => Promise<string | null>;
	saveVideoGrade: (assetId: string, grade: ImageGrade, lut?: string, output?: string) => Promise<{ assetId: string; path: string }>;
	/** Library-relative path, or null when the dialog is canceled. */
	pickGradeOutput: (assetId: string) => Promise<string | null>;
	pickGradeLut: () => Promise<{ path: string; name: string } | null>;
	isFullscreen: () => Promise<boolean>;
	onFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
	openDevTrace?: () => Promise<void>;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
