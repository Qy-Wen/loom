import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { LibraryChange } from "@loom/core";
import type { LoomSessionSummary as SessionSummary } from "@loom/agent";
import { DEV_TRACE_IPC } from "../shared/dev-trace.ts";
import type { ProcessSandboxNotice } from "../shared/agent-sandbox.ts";
import { IPC, type LoomApi } from "../shared/ipc.ts";

const api: LoomApi = {
	getCloudBackup: () => ipcRenderer.invoke(IPC.getCloudBackup),
	getCloudBackupConfig: (provider) => ipcRenderer.invoke(IPC.getCloudBackupConfig, provider),
	openRestoredCloudBackup: () => ipcRenderer.invoke(IPC.openRestoredCloudBackup),
	saveCloudBackup: (config) => ipcRenderer.invoke(IPC.saveCloudBackup, config),
	startCloudBackup: (operation, libraryId, revision) => ipcRenderer.invoke(IPC.startCloudBackup, operation, libraryId, revision),
	cancelCloudBackup: () => ipcRenderer.invoke(IPC.cancelCloudBackup),
	resolveCloudPull: (id, choices) => ipcRenderer.invoke(IPC.resolveCloudPull, id, choices),
	onCloudBackupChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, view: Parameters<typeof listener>[0]) => listener(view);
		ipcRenderer.on(IPC.cloudBackupChanged, handler);
		return () => ipcRenderer.removeListener(IPC.cloudBackupChanged, handler);
	},
	getAgentEndpoint: () => ipcRenderer.invoke(IPC.getAgentEndpoint),
	openLibrary: () => ipcRenderer.invoke(IPC.openLibrary),
	getLibrarySnapshot: () => ipcRenderer.invoke(IPC.getLibrarySnapshot),
	setFavorite: (assetId, favorite) => ipcRenderer.invoke(IPC.setFavorite, assetId, favorite),
	addAssetTag: (assetId, name) => ipcRenderer.invoke(IPC.addAssetTag, assetId, name),
	removeAssetTag: (assetId, tagId) => ipcRenderer.invoke(IPC.removeAssetTag, assetId, tagId),
	showAssetContextMenu: (assetId, single, tabs) => ipcRenderer.invoke(IPC.showAssetContextMenu, assetId, single, tabs),
	showAssetTabContextMenu: (pinned) => ipcRenderer.invoke(IPC.showAssetTabContextMenu, pinned),
	showFolderContextMenu: (relativePath, single) => ipcRenderer.invoke(IPC.showFolderContextMenu, relativePath, single),
	showLibraryContextMenu: () => ipcRenderer.invoke(IPC.showLibraryContextMenu),
	showCanvasContextMenu: (state) => ipcRenderer.invoke(IPC.showCanvasContextMenu, state),
	showTableContextMenu: (state) => ipcRenderer.invoke(IPC.showTableContextMenu, state),
	showEditorContextMenu: (state) => ipcRenderer.invoke(IPC.showEditorContextMenu, state),
	showMarkdownDropMenu: (nativeFilenames) => ipcRenderer.invoke(IPC.showMarkdownDropMenu, nativeFilenames),
	runEditorClipboard: (action) => ipcRenderer.invoke(IPC.runEditorClipboard, action),
	renameAsset: (assetId, filename) => ipcRenderer.invoke(IPC.renameAsset, assetId, filename),
	duplicateAsset: (assetId) => ipcRenderer.invoke(IPC.duplicateAsset, assetId),
	copyAssetsInto: (assetIds, destFolder) => ipcRenderer.invoke(IPC.copyAssetsInto, assetIds, destFolder),
	moveAssetsInto: (assetIds, destFolder) => ipcRenderer.invoke(IPC.moveAssetsInto, assetIds, destFolder),
	createFolder: (parentRelativePath) => ipcRenderer.invoke(IPC.createFolder, parentRelativePath),
	createMarkdownFile: (parentRelativePath) => ipcRenderer.invoke(IPC.createMarkdownFile, parentRelativePath),
	createCanvasFile: (parentRelativePath) => ipcRenderer.invoke(IPC.createCanvasFile, parentRelativePath),
	readCanvas: (assetId) => ipcRenderer.invoke(IPC.readCanvas, assetId),
	saveCanvas: (assetId, document, revision) => ipcRenderer.invoke(IPC.saveCanvas, assetId, document, revision),
	readMarkdown: (assetId) => ipcRenderer.invoke(IPC.readMarkdown, assetId),
	saveMarkdown: (assetId, text, revision) => ipcRenderer.invoke(IPC.saveMarkdown, assetId, text, revision),
	readHtml: (assetId) => ipcRenderer.invoke(IPC.readHtml, assetId),
	saveHtml: (assetId, text, revision) => ipcRenderer.invoke(IPC.saveHtml, assetId, text, revision),
	readTextFile: (assetId) => ipcRenderer.invoke(IPC.readTextFile, assetId),
	saveTextFile: (assetId, text, revision) => ipcRenderer.invoke(IPC.saveTextFile, assetId, text, revision),
	setCanvasDirty: (dirty) => ipcRenderer.send(IPC.canvasDirtyChanged, dirty),
	onFlushCanvasBeforeClose: (flush) => {
		const handler = () => { void flush().then((ok) => ipcRenderer.send(IPC.canvasCloseReady, ok), () => ipcRenderer.send(IPC.canvasCloseReady, false)); };
		ipcRenderer.on(IPC.flushCanvasBeforeClose, handler);
		return () => ipcRenderer.off(IPC.flushCanvasBeforeClose, handler);
	},
	renameFolder: (relativePath, name) => ipcRenderer.invoke(IPC.renameFolder, relativePath, name),
	copyFolderInto: (sourceFolder, destFolder) =>
		ipcRenderer.invoke(IPC.copyFolderInto, sourceFolder, destFolder),
	moveFolderInto: (sourceFolder, destFolder) =>
		ipcRenderer.invoke(IPC.moveFolderInto, sourceFolder, destFolder),
	copyAssetPath: (assetId) => ipcRenderer.invoke(IPC.copyAssetPath, assetId),
	copyFolderPath: (relativePath) => ipcRenderer.invoke(IPC.copyFolderPath, relativePath),
	revealAsset: (assetId) => ipcRenderer.invoke(IPC.revealAsset, assetId),
	revealFolder: (relativePath) => ipcRenderer.invoke(IPC.revealFolder, relativePath),
	trashAsset: (assetId) => ipcRenderer.invoke(IPC.trashAsset, assetId),
	trashFolder: (relativePath) => ipcRenderer.invoke(IPC.trashFolder, relativePath),
	trashLibraryItems: (assetIds, folders) => ipcRenderer.invoke(IPC.trashLibraryItems, assetIds, folders),
	copyLibraryPaths: (assetIds, folders) => ipcRenderer.invoke(IPC.copyLibraryPaths, assetIds, folders),
	copyLibraryItems: (assetIds, folders, move) => ipcRenderer.invoke(IPC.copyLibraryItems, assetIds, folders, move),
	isLibraryClipboardCurrent: (token) => ipcRenderer.invoke(IPC.isLibraryClipboardCurrent, token),
	pasteFromClipboard: (destFolder, targetIsSelectedFolder) => ipcRenderer.invoke(IPC.pasteFromClipboard, destFolder, targetIsSelectedFolder),
	placePathsInto: (absolutePaths, destFolder, move) => ipcRenderer.invoke(IPC.placePathsInto, absolutePaths, destFolder, move),
	onPasteConflict: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, request: Parameters<typeof listener>[0]) => listener(request);
		ipcRenderer.on(IPC.pasteConflict, handler);
		return () => ipcRenderer.removeListener(IPC.pasteConflict, handler);
	},
	resolvePasteConflict: (id, choice, applyAll) => ipcRenderer.invoke(IPC.resolvePasteConflict, id, choice, applyAll),
	getPropertySnapshot: () => ipcRenderer.invoke(IPC.getPropertySnapshot),
	createProperty: (name, type) => ipcRenderer.invoke(IPC.createProperty, name, type),
	updateProperty: (propertyId, name, type) =>
		ipcRenderer.invoke(IPC.updateProperty, propertyId, name, type),
	removeProperty: (propertyId) => ipcRenderer.invoke(IPC.removeProperty, propertyId),
	setAssetProperty: (assetId, propertyId, value) =>
		ipcRenderer.invoke(IPC.setAssetProperty, assetId, propertyId, value),
	removeAssetProperty: (assetId, propertyId) =>
		ipcRenderer.invoke(IPC.removeAssetProperty, assetId, propertyId),
	getAssetEnrichment: (assetId) => ipcRenderer.invoke(IPC.getAssetEnrichment, assetId),
	getAssetRelations: (assetId) => ipcRenderer.invoke(IPC.getAssetRelations, assetId),
	listGraphRelations: () => ipcRenderer.invoke(IPC.listGraphRelations),
	createRelation: (fromAssetId, toAssetId, type) =>
		ipcRenderer.invoke(IPC.createRelation, fromAssetId, toAssetId, type),
	removeRelation: (relationId) => ipcRenderer.invoke(IPC.removeRelation, relationId),
	getTextEmbedStatus: (assetId) => ipcRenderer.invoke(IPC.getTextEmbedStatus, assetId),
	embedAsset: (assetId, force) => ipcRenderer.invoke(IPC.embedAsset, assetId, force),
	getImageVlmStatus: (assetId) => ipcRenderer.invoke(IPC.getImageVlmStatus, assetId),
	describeImage: (assetId) => ipcRenderer.invoke(IPC.describeImage, assetId),
	getVideoVlmStatus: (assetId) => ipcRenderer.invoke(IPC.getVideoVlmStatus, assetId),
	describeVideo: (assetId) => ipcRenderer.invoke(IPC.describeVideo, assetId),
	getAudioWriteupStatus: (assetId) => ipcRenderer.invoke(IPC.getAudioWriteupStatus, assetId),
	describeAudio: (assetId) => ipcRenderer.invoke(IPC.describeAudio, assetId),
	listSessions: () => ipcRenderer.invoke(IPC.listSessions),
	listLibrarySkills: () => ipcRenderer.invoke(IPC.listLibrarySkills),
	createSession: () => ipcRenderer.invoke(IPC.createSession),
	compactSession: (id) => ipcRenderer.invoke(IPC.compactSession, id),
	openSession: (id) => ipcRenderer.invoke(IPC.openSession, id),
	getSession: (id, afterEntryId) => ipcRenderer.invoke(IPC.getSession, id, afterEntryId),
	stageComposerAssets: (id, assets) => ipcRenderer.invoke(IPC.stageComposerAssets, id, assets),
	pickComposerLibraryAssets: () => ipcRenderer.invoke(IPC.pickComposerLibraryAssets),
	importComposerFiles: (filePaths, images) => ipcRenderer.invoke(IPC.importComposerFiles, filePaths, images),
	pickComposerExternalFiles: () => ipcRenderer.invoke(IPC.pickComposerExternalFiles),
	pathForFile: (file) => webUtils.getPathForFile(file),
	followUp: (id, text, clientMessageId) => ipcRenderer.invoke(IPC.followUp, id, text, clientMessageId),
	cancelFollowUp: (id, clientMessageId) => ipcRenderer.invoke(IPC.cancelFollowUp, id, clientMessageId),
	branchBefore: (id, entryId, model) => ipcRenderer.invoke(IPC.branchBefore, id, entryId, model),
	setSessionModel: (id, selection) => ipcRenderer.invoke(IPC.setSessionModel, id, selection),
	renameSession: (root, id, title) => ipcRenderer.invoke(IPC.renameSession, root, id, title),
	forkAfter: (id, entryId) => ipcRenderer.invoke(IPC.forkAfter, id, entryId),
	archiveSession: (id) => ipcRenderer.invoke(IPC.archiveSession, id),
	unarchiveSession: (id) => ipcRenderer.invoke(IPC.unarchiveSession, id),
	deleteSession: (id) => ipcRenderer.invoke(IPC.deleteSession, id),
	onLibraryChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, change: LibraryChange) => listener(change);
		ipcRenderer.on(IPC.libraryChanged, handler);
		return () => ipcRenderer.removeListener(IPC.libraryChanged, handler);
	},
	onTrashStarted: (listener) => {
		const handler = () => listener();
		ipcRenderer.on(IPC.trashStarted, handler);
		return () => ipcRenderer.removeListener(IPC.trashStarted, handler);
	},
	onSessionsChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, sessions: SessionSummary[]) => listener(sessions);
		ipcRenderer.on(IPC.sessionsChanged, handler);
		return () => ipcRenderer.removeListener(IPC.sessionsChanged, handler);
	},
	onSettingsChanged: (listener) => {
		const handler = () => listener();
		ipcRenderer.on(IPC.settingsChanged, handler);
		return () => ipcRenderer.removeListener(IPC.settingsChanged, handler);
	},
	onProcessSandboxDisabled: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, notice: ProcessSandboxNotice) => listener(notice);
		ipcRenderer.on(IPC.processSandboxDisabled, handler);
		return () => ipcRenderer.removeListener(IPC.processSandboxDisabled, handler);
	},
	getProcessSandboxNotice: () => ipcRenderer.invoke(IPC.getProcessSandboxNotice),
	acknowledgeProcessSandboxNotice: (id) => ipcRenderer.invoke(IPC.acknowledgeProcessSandboxNotice, id),
	isFullscreen: () => ipcRenderer.invoke(IPC.isFullscreen),
	onFullscreenChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean) => listener(fullscreen);
		ipcRenderer.on(IPC.fullscreenChanged, handler);
		return () => ipcRenderer.removeListener(IPC.fullscreenChanged, handler);
	},
	isMaximized: () => ipcRenderer.invoke(IPC.isMaximized),
	onMaximizedChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized);
		ipcRenderer.on(IPC.maximizedChanged, handler);
		return () => ipcRenderer.removeListener(IPC.maximizedChanged, handler);
	},
	windowAction: (action) => ipcRenderer.send(IPC.windowAction, action),
	getModelSettings: () => ipcRenderer.invoke(IPC.getModelSettings),
	saveModelSettings: (draft) => ipcRenderer.invoke(IPC.saveModelSettings, draft),
	probeModelSlot: (draft) => ipcRenderer.invoke(IPC.probeModelSlot, draft),
	getChatSettings: () => ipcRenderer.invoke(IPC.getChatSettings),
	saveChatSettings: (config) => ipcRenderer.invoke(IPC.saveChatSettings, config),
	patchChatSettings: (patch) => ipcRenderer.invoke(IPC.patchChatSettings, patch),
	chatProviderCatalog: () => ipcRenderer.invoke(IPC.chatProviderCatalog),
	chatLogin: (providerId, type) => ipcRenderer.invoke(IPC.chatLogin, providerId, type),
	chatLoginResponse: (value) => ipcRenderer.invoke(IPC.chatLoginResponse, value),
	chatCancelLogin: () => ipcRenderer.invoke(IPC.chatCancelLogin),
	chatLogout: (providerId) => ipcRenderer.invoke(IPC.chatLogout, providerId),
	chatRefresh: () => ipcRenderer.invoke(IPC.chatRefresh),
	onChatLoginPrompt: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, prompt: unknown) => listener(prompt as Parameters<typeof listener>[0]);
		ipcRenderer.on(IPC.chatLoginPrompt, handler as Parameters<typeof ipcRenderer.on>[1]);
		return () => ipcRenderer.removeListener(IPC.chatLoginPrompt, handler as Parameters<typeof ipcRenderer.removeListener>[1]);
	},
	onChatSettingsChanged: (listener) => {
		const handler = () => listener();
		ipcRenderer.on(IPC.chatSettingsChanged, handler);
		return () => ipcRenderer.removeListener(IPC.chatSettingsChanged, handler);
	},
	getMcpSettings: () => ipcRenderer.invoke(IPC.getMcpSettings),
	getMcpService: () => ipcRenderer.invoke(IPC.getMcpService),
	saveMcpService: (settings) => ipcRenderer.invoke(IPC.saveMcpService, settings),
	onMcpServiceChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, view: Parameters<typeof listener>[0]) => listener(view);
		ipcRenderer.on(IPC.mcpServiceChanged, handler);
		return () => ipcRenderer.removeListener(IPC.mcpServiceChanged, handler);
	},
	cancelExternalTool: (id) => ipcRenderer.invoke(IPC.cancelExternalTool, id),
	saveMcpSettings: (servers) => ipcRenderer.invoke(IPC.saveMcpSettings, servers),
	setMcpServerLive: (server) => ipcRenderer.invoke(IPC.setMcpServerLive, server),
	getAgentInstructions: () => ipcRenderer.invoke(IPC.getAgentInstructions),
	saveAgentInstructions: (text) => ipcRenderer.invoke(IPC.saveAgentInstructions, text),
	getGeneralSettings: () => ipcRenderer.invoke(IPC.getGeneralSettings),
	saveGeneralSettings: (settings) => ipcRenderer.invoke(IPC.saveGeneralSettings, settings),
	getAgentSandbox: () => ipcRenderer.invoke(IPC.getAgentSandbox),
	saveAgentSandbox: (enabled) => ipcRenderer.invoke(IPC.saveAgentSandbox, enabled),
	getAgentStats: () => ipcRenderer.invoke(IPC.getAgentStats),
	resetAgentStats: () => ipcRenderer.invoke(IPC.resetAgentStats),
	setUiSelection: (selection) => ipcRenderer.invoke(IPC.setUiSelection, selection),
	getAgentPermission: () => ipcRenderer.invoke(IPC.getAgentPermission),
	setAgentPermission: (level) => ipcRenderer.invoke(IPC.setAgentPermission, level),
	resolveToolGate: (toolCallId, decision) => ipcRenderer.invoke(IPC.resolveToolGate, toolCallId, decision),
	getCommandAllows: () => ipcRenderer.invoke(IPC.getCommandAllows),
	onCommandAllowsChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, view: Parameters<typeof listener>[0]) => listener(view);
		ipcRenderer.on(IPC.commandAllowsChanged, handler);
		return () => ipcRenderer.removeListener(IPC.commandAllowsChanged, handler);
	},
	previewImageGrade: (assetId, grade, lut, force) => ipcRenderer.invoke(IPC.previewImageGrade, assetId, grade, lut, force),
	saveImageGrade: (assetId, grade, lut, output) => ipcRenderer.invoke(IPC.saveImageGrade, assetId, grade, lut, output),
	getVideoGradeInfo: (assetId) => ipcRenderer.invoke(IPC.getVideoGradeInfo, assetId),
	previewVideoGrade: (assetId, timeSeconds, grade, lut, force) => ipcRenderer.invoke(IPC.previewVideoGrade, assetId, timeSeconds, grade, lut, force),
	saveVideoGrade: (assetId, grade, lut, output) => ipcRenderer.invoke(IPC.saveVideoGrade, assetId, grade, lut, output),
	pickGradeOutput: (assetId) => ipcRenderer.invoke(IPC.pickGradeOutput, assetId),
	pickGradeLut: () => ipcRenderer.invoke(IPC.pickGradeLut),
	openDevTrace: (): Promise<void> => ipcRenderer.invoke(DEV_TRACE_IPC.open),
};

contextBridge.exposeInMainWorld("loom", api);


