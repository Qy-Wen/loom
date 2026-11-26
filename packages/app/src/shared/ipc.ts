import type { CloudBackupView, CloudConfigDraft, CloudJob, CloudProviderId, CloudPullChoice } from "./cloud-backup.ts";
import type { CanvasDocument, CanvasSnapshot } from "./canvas.ts";
import type { TextFileSaveResult, TextFileSnapshot } from "./text-file.ts";
import type { ChatSettingsPatch } from "./chat-settings.ts";
import type { ComposerReference } from "@loom/agent";
import type { McpServiceSettings, McpServiceView } from "./mcp-service.ts";
/** Typed contract shared by Electron main, preload, and renderer. */
import type { ProcessSandboxNotice } from "./agent-sandbox.ts";
import type { ImageGrade } from "@loom/core/grade";
import type {
	Asset,
	AssetType,
	AssetEnrichment,
	AssetPropertyValue,
	AssetRelation,
	AssetRelationsResult,
	LibraryChange,
	LibrarySnapshot,
	PastedLibraryItems,
	PasteConflict,
	PasteChoice,
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
	CommandAllowView,
	ComposerImageInput,
	LoomSessionRecord as SessionRecord,
	LoomSessionSummary as SessionSummary,
	ToolGateDecision,
} from "@loom/agent";
import type { McpServerDraft, McpServerStatus, McpSettingsView, McpSettingsPatch } from "./mcp-settings.ts";
import type { GeneralSettings } from "./general-settings.ts";
import type { ModelProbeDraft, ModelSettingsPatch, ModelSettingsView, ProbeResult } from "./model-settings.ts";
import type { ChatModelsConfig } from "@loom/agent/chat-models";
import type { ChatAuthStatus, ChatModelView } from "./chat-models.ts";

export type ChatSettingsView = {
	config: ChatModelsConfig;
	models: ChatModelView[];
	auth: ChatAuthStatus[];
	refreshErrors: Record<string, string>;
};

/** Built-in provider catalog row for the settings UI. */
export type ChatProviderCatalogEntry = {
	id: string;
	name: string;
	apiKeyAuth: boolean;
	oauthAuth: boolean;
};

/** Login prompt forwarded from Main to the renderer during a login flow. */
export type ChatLoginPrompt =
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string; /** Only in explicit API-key editing flows; never ordinary settings reads. */ initialValue?: string }
	| { type: "select"; message: string; options: { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "progress"; message: string };

export type LibraryCreateAction = "new_folder" | "new_md_file" | "new_canvas";
export type AssetContextAction =
	| LibraryCreateAction
	| "open"
	| "open_in_new_tab"
	| "add_to_chat"
	| "favorite"
	| "unfavorite"
	| "rename"
	| "cut"
	| "copy"
	| "paste"
	| "copy_path"
	| "reveal"
	| "trash";
export type AssetTabContextAction = "pin" | "unpin" | "locate";
export type FolderContextAction =
	| LibraryCreateAction
	| "rename"
	| "cut"
	| "copy"
	| "paste"
	| "copy_path"
	| "reveal"
	| "trash";
export type LibraryContextAction = "paste" | LibraryCreateAction;
export type CanvasContextAction = "add_files" | "group" | "locate";
export interface CanvasContextState {
	canGroup: boolean;
	canLocate: boolean;
}
export type EditorClipboardAction = "cut" | "copy" | "paste";
export type EditorContextAction = EditorClipboardAction | "undo" | "redo" | "select_all";
export interface EditorContextState {
	readOnly: boolean;
	canUndo: boolean;
	canRedo: boolean;
	canCopy: boolean;
}
export const markdownFormats = {
	inline: ["bold", "italic", "strikethrough", "inlineCode"],
	block: ["paragraph", "heading1", "heading2", "heading3", "bullet", "ordered", "task", "quote"],
} as const;
export type MarkdownInlineFormat = typeof markdownFormats.inline[number];
export type MarkdownBlockFormat = typeof markdownFormats.block[number];
export type MarkdownFormat = MarkdownInlineFormat | MarkdownBlockFormat;
export type MarkdownContextAction = EditorContextAction | MarkdownFormat | "open_embed" | "edit_embed" | "remove_embed";
export type MarkdownDropAction = "link" | "embed";
export interface MarkdownContextState extends EditorContextState {
	embed?: boolean;
	removeEmbed?: boolean;
	/** Available formatting actions and whether the full selection already has each format. */
	formats: Partial<Record<MarkdownFormat, boolean>>;
}
/** A table menu includes text editing and the row/column operations allowed by its selection. */
export type TableContextAction = EditorContextAction | "add_row_above" | "add_row_below" | "add_column_left" | "add_column_right" | "delete_row" | "delete_column" | "align_left" | "align_center" | "align_right";
export interface TableContextState extends EditorContextState {
	canDeleteRow: boolean;
	canDeleteColumn: boolean;
	/** How the column of the cell is aligned now, which the menu marks. */
	align: "left" | "center" | "right" | "";
}

export type SessionCompactionResult = "compacted" | "unchanged" | "cancelled";
export type LibrarySkillSummary = { name: string; description: string };

export interface AgentEndpoint {
	url: string;
	token: string;
}

export interface UiSelectionDraft {
	assetId: string;
	path: string;
	assetType: AssetType;
}

export const IPC = {
	getCloudBackup: "loom:getCloudBackup",
	getCloudBackupConfig: "loom:getCloudBackupConfig",
	openRestoredCloudBackup: "loom:openRestoredCloudBackup",
	saveCloudBackup: "loom:saveCloudBackup",
	startCloudBackup: "loom:startCloudBackup",
	cancelCloudBackup: "loom:cancelCloudBackup",
	resolveCloudPull: "loom:resolveCloudPull",
	cloudBackupChanged: "loom:cloudBackupChanged",
	getAgentEndpoint: "loom:getAgentEndpoint",
	openLibrary: "loom:openLibrary",
	getLibrarySnapshot: "loom:getLibrarySnapshot",
	setFavorite: "loom:setFavorite",
	addAssetTag: "loom:addAssetTag",
	removeAssetTag: "loom:removeAssetTag",
	libraryChanged: "loom:libraryChanged",
	trashStarted: "loom:trashStarted",
	showAssetContextMenu: "loom:showAssetContextMenu",
	showAssetTabContextMenu: "loom:showAssetTabContextMenu",
	showFolderContextMenu: "loom:showFolderContextMenu",
	showLibraryContextMenu: "loom:showLibraryContextMenu",
	showCanvasContextMenu: "loom:showCanvasContextMenu",
	showTableContextMenu: "loom:showTableContextMenu",
	showEditorContextMenu: "loom:showEditorContextMenu",
	showMarkdownDropMenu: "loom:showMarkdownDropMenu",
	runEditorClipboard: "loom:runEditorClipboard",
	renameAsset: "loom:renameAsset",
	duplicateAsset: "loom:duplicateAsset",
	copyAssetsInto: "loom:copyAssetsInto",
	moveAssetsInto: "loom:moveAssetsInto",
	createFolder: "loom:createFolder",
	createMarkdownFile: "loom:createMarkdownFile",
	createCanvasFile: "loom:createCanvasFile",
	readCanvas: "loom:readCanvas",
	saveCanvas: "loom:saveCanvas",
	readMarkdown: "loom:readMarkdown",
	saveMarkdown: "loom:saveMarkdown",
	readHtml: "loom:readHtml",
	saveHtml: "loom:saveHtml",
	readTextFile: "loom:readTextFile",
	saveTextFile: "loom:saveTextFile",
	canvasDirtyChanged: "loom:canvasDirtyChanged",
	flushCanvasBeforeClose: "loom:flushCanvasBeforeClose",
	canvasCloseReady: "loom:canvasCloseReady",
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
	copyLibraryItems: "loom:copyLibraryItems",
	isLibraryClipboardCurrent: "loom:isLibraryClipboardCurrent",
	pasteFromClipboard: "loom:pasteFromClipboard",
	placePathsInto: "loom:placePathsInto",
	pasteConflict: "loom:pasteConflict",
	resolvePasteConflict: "loom:resolvePasteConflict",
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
	getTextEmbedStatus: "loom:getTextEmbedStatus",
	embedAsset: "loom:embedAsset",
	getImageVlmStatus: "loom:getImageVlmStatus",
	describeImage: "loom:describeImage",
	getVideoVlmStatus: "loom:getVideoVlmStatus",
	describeVideo: "loom:describeVideo",
	getAudioWriteupStatus: "loom:getAudioWriteupStatus",
	describeAudio: "loom:describeAudio",
	listSessions: "loom:listSessions",
	listLibrarySkills: "loom:listLibrarySkills",
	createSession: "loom:createSession",
	compactSession: "loom:compactSession",
	openSession: "loom:openSession",
	getSession: "loom:getSession",
	stageComposerAssets: "loom:stageComposerAssets",
	pickComposerLibraryAssets: "loom:pickComposerLibraryAssets",
	importComposerFiles: "loom:importComposerFiles",
	pickComposerExternalFiles: "loom:pickComposerExternalFiles",
	followUp: "loom:followUp",
	cancelFollowUp: "loom:cancelFollowUp",
	branchBefore: "loom:branchBefore",
	setSessionModel: "loom:setSessionModel",
	renameSession: "loom:renameSession",
	forkAfter: "loom:forkAfter",
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
	getChatSettings: "loom:getChatSettings",
	saveChatSettings: "loom:saveChatSettings",
	patchChatSettings: "loom:patchChatSettings",
	chatProviderCatalog: "loom:chatProviderCatalog",
	chatLogin: "loom:chatLogin",
	chatLoginPrompt: "loom:chatLoginPrompt",
	chatLoginResponse: "loom:chatLoginResponse",
	chatCancelLogin: "loom:chatCancelLogin",
	chatLogout: "loom:chatLogout",
	chatRefresh: "loom:chatRefresh",
	chatSettingsChanged: "loom:chatSettingsChanged",
	getMcpSettings: "loom:getMcpSettings",
	getMcpService: "loom:getMcpService",
	saveMcpService: "loom:saveMcpService",
	mcpServiceChanged: "loom:mcpServiceChanged",
	cancelExternalTool: "loom:cancelExternalTool",
	saveMcpSettings: "loom:saveMcpSettings",
	setMcpServerLive: "loom:setMcpServerLive",
	getAgentInstructions: "loom:getAgentInstructions",
	saveAgentInstructions: "loom:saveAgentInstructions",
	getGeneralSettings: "loom:getGeneralSettings",
	saveGeneralSettings: "loom:saveGeneralSettings",
	getAgentSandbox: "loom:getAgentSandbox",
	saveAgentSandbox: "loom:saveAgentSandbox",
	setUiSelection: "loom:setUiSelection",
	getAgentPermission: "loom:getAgentPermission",
	setAgentPermission: "loom:setAgentPermission",
	resolveToolGate: "loom:resolveToolGate",
	getCommandAllows: "loom:getCommandAllows",
	commandAllowsChanged: "loom:commandAllowsChanged",
	previewImageGrade: "loom:previewImageGrade",
	saveImageGrade: "loom:saveImageGrade",
	getVideoGradeInfo: "loom:getVideoGradeInfo",
	previewVideoGrade: "loom:previewVideoGrade",
	saveVideoGrade: "loom:saveVideoGrade",
	pickGradeOutput: "loom:pickGradeOutput",
	pickGradeLut: "loom:pickGradeLut",
	isFullscreen: "loom:isFullscreen",
	fullscreenChanged: "loom:fullscreenChanged",
	isMaximized: "loom:isMaximized",
	maximizedChanged: "loom:maximizedChanged",
	windowAction: "loom:windowAction",
} as const;

export interface LoomApi {
	getCloudBackup: () => Promise<CloudBackupView>;
	/** Load saved credentials only for the cloud settings form; inputs mask them by default. */
	getCloudBackupConfig: (provider?: CloudProviderId) => Promise<CloudConfigDraft>;
	openRestoredCloudBackup: () => Promise<void>;
	saveCloudBackup: (config: CloudConfigDraft) => Promise<CloudBackupView>;
	startCloudBackup: (operation: CloudJob["operation"], libraryId?: string, revision?: string) => Promise<void>;
	cancelCloudBackup: () => Promise<void>;
	resolveCloudPull: (id: string, choices: Record<string, CloudPullChoice>) => Promise<void>;
	onCloudBackupChanged: (listener: (view: CloudBackupView) => void) => () => void;
	getAgentEndpoint: () => Promise<AgentEndpoint>;
	openLibrary: () => Promise<LibrarySnapshot | null>;
	getLibrarySnapshot: () => Promise<LibrarySnapshot>;
	setFavorite: (assetId: string, favorite: boolean) => Promise<void>;
	addAssetTag: (assetId: string, name: string) => Promise<void>;
	removeAssetTag: (assetId: string, tagId: string) => Promise<void>;
	onLibraryChanged: (listener: (change: LibraryChange) => void) => () => void;
	onTrashStarted: (listener: () => void) => () => void;
	/** `tabs` is true in list mode, where a file can open in a new tab; otherwise the first item opens the preview. */
	showAssetContextMenu: (assetId: string, single: boolean, tabs: boolean) => Promise<AssetContextAction | null>;
	showAssetTabContextMenu: (pinned: boolean) => Promise<AssetTabContextAction | null>;
	showFolderContextMenu: (relativePath: string, single: boolean) => Promise<FolderContextAction | null>;
	showLibraryContextMenu: () => Promise<LibraryContextAction | null>;
	showCanvasContextMenu: (state: CanvasContextState) => Promise<CanvasContextAction | null>;
	showTableContextMenu: (state: TableContextState) => Promise<TableContextAction | null>;
	showEditorContextMenu: (state: MarkdownContextState) => Promise<MarkdownContextAction | null>;
	showMarkdownDropMenu: (nativeFilenames?: readonly string[]) => Promise<MarkdownDropAction | null>;
	/** Use Chromium's clipboard events, including CodeMirror and table-specific formats. */
	runEditorClipboard: (action: EditorClipboardAction) => Promise<void>;
	renameAsset: (assetId: string, filename: string) => Promise<Asset>;
	duplicateAsset: (assetId: string) => Promise<Asset>;
	copyAssetsInto: (assetIds: string[], destFolder: string) => Promise<Asset[]>;
	moveAssetsInto: (assetIds: string[], destFolder: string) => Promise<Asset[]>;
	createFolder: (parentRelativePath: string) => Promise<string>;
	createMarkdownFile: (parentRelativePath: string) => Promise<Asset>;
	createCanvasFile: (parentRelativePath: string) => Promise<Asset>;
	readCanvas: (assetId: string) => Promise<CanvasSnapshot>;
	saveCanvas: (assetId: string, document: CanvasDocument, revision: string) => Promise<CanvasSnapshot | null>;
	readMarkdown: (assetId: string) => Promise<TextFileSnapshot>;
	saveMarkdown: (assetId: string, text: string, revision: string) => Promise<TextFileSaveResult>;
	readHtml: (assetId: string) => Promise<TextFileSnapshot>;
	saveHtml: (assetId: string, text: string, revision: string) => Promise<TextFileSaveResult>;
	readTextFile: (assetId: string) => Promise<TextFileSnapshot>;
	saveTextFile: (assetId: string, text: string, revision: string) => Promise<TextFileSaveResult>;
	setCanvasDirty: (dirty: boolean) => void;
	onFlushCanvasBeforeClose: (flush: () => Promise<boolean>) => () => void;
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
	copyLibraryItems: (assetIds: string[], folders: string[], move: boolean) => Promise<string>;
	isLibraryClipboardCurrent: (token: string) => Promise<boolean>;
	pasteFromClipboard: (destFolder: string, targetIsSelectedFolder?: boolean) => Promise<(PastedLibraryItems & { destinationFolder: string }) | null>;
	placePathsInto: (absolutePaths: string[], destFolder: string, move: boolean) => Promise<PastedLibraryItems>;
	onPasteConflict: (listener: (request: { id: number; conflict: PasteConflict | null }) => void) => () => void;
	resolvePasteConflict: (id: number, choice: PasteChoice, applyAll: boolean) => Promise<void>;
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
	getTextEmbedStatus: (assetId: string) => Promise<TextEmbedStatus>;
	/** `force` rebuilds the index even when it looks current. */
	embedAsset: (assetId: string, force?: boolean) => Promise<TextEmbedStatus>;
	getImageVlmStatus: (assetId: string) => Promise<ImageVlmStatus>;
	describeImage: (assetId: string) => Promise<ImageVlmStatus>;
	getVideoVlmStatus: (assetId: string) => Promise<VideoVlmStatus>;
	describeVideo: (assetId: string) => Promise<VideoVlmStatus>;
	getAudioWriteupStatus: (assetId: string) => Promise<AudioWriteupStatus>;
	describeAudio: (assetId: string) => Promise<AudioWriteupStatus>;
	listSessions: () => Promise<SessionSummary[]>;
	listLibrarySkills: () => Promise<LibrarySkillSummary[]>;
	createSession: () => Promise<SessionRecord>;
	compactSession: (id: string) => Promise<SessionCompactionResult>;
	openSession: (id: string) => Promise<SessionRecord>;
	/** Load full history initially, then only entries after the last committed ID. */
	getSession: (id: string, afterEntryId?: string) => Promise<SessionRecord>;
	/** Stage library chips and supported image bytes for the next prompt or follow-up. */
	stageComposerAssets: (id: string, assets: Array<ComposerReference | UiSelectionDraft>) => Promise<void>;
	/** Open a file dialog inside the library and return indexed assets as composer chips. */
	pickComposerLibraryAssets: () => Promise<UiSelectionDraft[]>;
	/** Copy files into Inbox (or reuse if they are already in the library) and return composer chips. */
	importComposerFiles: (filePaths: string[], images?: ComposerImageInput[]) => Promise<UiSelectionDraft[]>;
	/** Open a file dialog anywhere, import into Inbox, and return composer chips. */
	pickComposerExternalFiles: () => Promise<UiSelectionDraft[]>;
	pathForFile: (file: File) => string;
	/** Queue text into the active run. Inserted when that run would otherwise finish. */
	followUp: (id: string, text: string, clientMessageId?: string) => Promise<void>;
	/** Withdraw a queued follow-up that has not been placed into the run yet; resolves false if it was too late. */
	cancelFollowUp: (id: string, clientMessageId: string) => Promise<boolean>;
	/** Create a branch before this question with an optional model override, then archive the source. */
	branchBefore: (id: string, entryId: string, model?: SessionRecord["model"]) => Promise<SessionRecord>;
	/** Persist this conversation's model/thinking; applies from the next request. Rejects while busy. */
	setSessionModel: (id: string, selection: { provider: string; modelId: string; thinkingLevel?: string }) => Promise<SessionRecord>;
	renameSession: (root: string, id: string, title: string) => Promise<void>;
	/** Open a new session from the history up to and including this entry (a reply). */
	forkAfter: (id: string, entryId: string) => Promise<SessionRecord>;
	archiveSession: (id: string) => Promise<void>;
	unarchiveSession: (id: string) => Promise<void>;
	deleteSession: (id: string) => Promise<void>;
	onSessionsChanged: (listener: (sessions: SessionSummary[]) => void) => () => void;
	onSettingsChanged: (listener: () => void) => () => void;
	onProcessSandboxDisabled: (listener: (notice: ProcessSandboxNotice) => void) => () => void;
	getProcessSandboxNotice: () => Promise<ProcessSandboxNotice | null>;
	acknowledgeProcessSandboxNotice: (id: string) => Promise<void>;
	getModelSettings: () => Promise<ModelSettingsView>;
	saveModelSettings: (draft: ModelSettingsPatch) => Promise<ModelSettingsView>;
	probeModelSlot: (draft: ModelProbeDraft) => Promise<ProbeResult>;
	getChatSettings: () => Promise<ChatSettingsView>;
	saveChatSettings: (config: ChatModelsConfig) => Promise<ChatSettingsView>;
	patchChatSettings: (patch: ChatSettingsPatch) => Promise<ChatSettingsView>;
	chatProviderCatalog: () => Promise<ChatProviderCatalogEntry[]>;
	/** Resolves when the whole flow settles; prompts arrive via onChatLoginPrompt. */
	chatLogin: (providerId: string, type: "api_key" | "oauth") => Promise<void>;
	/** Answer the pending prompt; rejects when no prompt is pending. */
	chatLoginResponse: (value: string) => Promise<void>;
	chatCancelLogin: () => Promise<void>;
	/** Remove the credential Loom stored for a provider. Keys from environment variables are not affected. */
	chatLogout: (providerId: string) => Promise<void>;
	chatRefresh: () => Promise<ChatSettingsView>;
	onChatLoginPrompt: (listener: (prompt: ChatLoginPrompt & { providerId: string; authType: "api_key" | "oauth" }) => void) => () => void;
	onChatSettingsChanged: (listener: () => void) => () => void;
	getMcpSettings: () => Promise<McpSettingsView>;
	getMcpService: () => Promise<McpServiceView>;
	saveMcpService: (settings: McpServiceSettings) => Promise<McpServiceView>;
	onMcpServiceChanged: (listener: (view: McpServiceView) => void) => () => void;
	cancelExternalTool: (id: string) => Promise<boolean>;
	saveMcpSettings: (patch: McpSettingsPatch) => Promise<McpSettingsView>;
	setMcpServerLive: (server: McpServerDraft) => Promise<McpServerStatus>;
	getAgentInstructions: () => Promise<string>;
	saveAgentInstructions: (text: string) => Promise<string>;
	getGeneralSettings: () => Promise<GeneralSettings>;
	saveGeneralSettings: (settings: Partial<GeneralSettings>) => Promise<GeneralSettings>;
	getAgentSandbox: () => Promise<boolean>;
	saveAgentSandbox: (enabled: boolean) => Promise<boolean>;
	setUiSelection: (selection: UiSelectionDraft | null) => Promise<void>;
	getAgentPermission: () => Promise<AgentPermissionLevel>;
	setAgentPermission: (level: AgentPermissionLevel) => Promise<AgentPermissionLevel>;
	resolveToolGate: (toolCallId: string, decision: ToolGateDecision) => Promise<boolean>;
	getCommandAllows: () => Promise<CommandAllowView>;
	onCommandAllowsChanged: (listener: (view: CommandAllowView) => void) => () => void;
	/** JPEG bytes, base64. Null when the grade leaves the image unchanged. */
	previewImageGrade: (assetId: string, grade: ImageGrade, lut?: string, force?: boolean) => Promise<Uint8Array | null>;
	saveImageGrade: (assetId: string, grade: ImageGrade, lut?: string, output?: string) => Promise<{ assetId: string; path: string }>;
	getVideoGradeInfo: (assetId: string) => Promise<{ duration: number }>;
	/** JPEG bytes of one graded frame, base64. Null when the grade leaves the frame unchanged. */
	previewVideoGrade: (assetId: string, timeSeconds: number, grade: ImageGrade, lut?: string, force?: boolean) => Promise<Uint8Array | null>;
	saveVideoGrade: (assetId: string, grade: ImageGrade, lut?: string, output?: string) => Promise<{ assetId: string; path: string }>;
	/** Library-relative path, or null when the dialog is canceled. */
	pickGradeOutput: (assetId: string) => Promise<string | null>;
	pickGradeLut: () => Promise<{ path: string; name: string } | null>;
	isFullscreen: () => Promise<boolean>;
	onFullscreenChanged: (listener: (fullscreen: boolean) => void) => () => void;
	isMaximized: () => Promise<boolean>;
	onMaximizedChanged: (listener: (maximized: boolean) => void) => () => void;
	windowAction: (action: "minimize" | "toggleMaximize" | "close") => void;
	openDevTrace: () => Promise<void>;
}

declare global {
	interface Window {
		loom: LoomApi;
	}
}
