import { contextBridge, ipcRenderer } from "electron";
import type { LibraryChange, SessionSummary } from "@loom/core";
import { IPC, type LoomApi } from "../shared/ipc.ts";

const api: LoomApi = {
	getAgentEndpoint: () => ipcRenderer.invoke(IPC.getAgentEndpoint),
	openLibrary: () => ipcRenderer.invoke(IPC.openLibrary),
	getLibrarySnapshot: () => ipcRenderer.invoke(IPC.getLibrarySnapshot),
	showAssetContextMenu: (assetId, canPaste) => ipcRenderer.invoke(IPC.showAssetContextMenu, assetId, canPaste),
	showFolderContextMenu: (relativePath, canPaste) =>
		ipcRenderer.invoke(IPC.showFolderContextMenu, relativePath, canPaste),
	showLibraryContextMenu: (canPaste) => ipcRenderer.invoke(IPC.showLibraryContextMenu, canPaste),
	renameAsset: (assetId, stem) => ipcRenderer.invoke(IPC.renameAsset, assetId, stem),
	duplicateAsset: (assetId) => ipcRenderer.invoke(IPC.duplicateAsset, assetId),
	copyAssetsInto: (assetIds, destFolder) => ipcRenderer.invoke(IPC.copyAssetsInto, assetIds, destFolder),
	createFolder: (parentRelativePath) => ipcRenderer.invoke(IPC.createFolder, parentRelativePath),
	createMarkdownFile: (parentRelativePath) => ipcRenderer.invoke(IPC.createMarkdownFile, parentRelativePath),
	renameFolder: (relativePath, name) => ipcRenderer.invoke(IPC.renameFolder, relativePath, name),
	copyFolderInto: (sourceFolder, destFolder) =>
		ipcRenderer.invoke(IPC.copyFolderInto, sourceFolder, destFolder),
	copyAssetPath: (assetId) => ipcRenderer.invoke(IPC.copyAssetPath, assetId),
	copyFolderPath: (relativePath) => ipcRenderer.invoke(IPC.copyFolderPath, relativePath),
	revealAsset: (assetId) => ipcRenderer.invoke(IPC.revealAsset, assetId),
	revealFolder: (relativePath) => ipcRenderer.invoke(IPC.revealFolder, relativePath),
	trashAsset: (assetId) => ipcRenderer.invoke(IPC.trashAsset, assetId),
	trashFolder: (relativePath) => ipcRenderer.invoke(IPC.trashFolder, relativePath),
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
	analyzeAsset: (assetId) => ipcRenderer.invoke(IPC.analyzeAsset, assetId),
	getTextEmbedStatus: (assetId) => ipcRenderer.invoke(IPC.getTextEmbedStatus, assetId),
	embedAsset: (assetId) => ipcRenderer.invoke(IPC.embedAsset, assetId),
	getImageVlmStatus: (assetId) => ipcRenderer.invoke(IPC.getImageVlmStatus, assetId),
	describeImage: (assetId) => ipcRenderer.invoke(IPC.describeImage, assetId),
	listSessions: () => ipcRenderer.invoke(IPC.listSessions),
	createSession: () => ipcRenderer.invoke(IPC.createSession),
	openSession: (id) => ipcRenderer.invoke(IPC.openSession, id),
	getSession: (id) => ipcRenderer.invoke(IPC.getSession, id),
	archiveSession: (id) => ipcRenderer.invoke(IPC.archiveSession, id),
	unarchiveSession: (id) => ipcRenderer.invoke(IPC.unarchiveSession, id),
	deleteSession: (id) => ipcRenderer.invoke(IPC.deleteSession, id),
	onLibraryChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, change: LibraryChange) => listener(change);
		ipcRenderer.on(IPC.libraryChanged, handler);
		return () => ipcRenderer.removeListener(IPC.libraryChanged, handler);
	},
	onSessionsChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, sessions: SessionSummary[]) => listener(sessions);
		ipcRenderer.on(IPC.sessionsChanged, handler);
		return () => ipcRenderer.removeListener(IPC.sessionsChanged, handler);
	},
	getModelSettings: () => ipcRenderer.invoke(IPC.getModelSettings),
	saveModelSettings: (draft) => ipcRenderer.invoke(IPC.saveModelSettings, draft),
	getMcpSettings: () => ipcRenderer.invoke(IPC.getMcpSettings),
	saveMcpSettings: (servers) => ipcRenderer.invoke(IPC.saveMcpSettings, servers),
	getAgentStats: () => ipcRenderer.invoke(IPC.getAgentStats),
	resetAgentStats: () => ipcRenderer.invoke(IPC.resetAgentStats),
	setUiSelection: (selection) => ipcRenderer.invoke(IPC.setUiSelection, selection),
};

contextBridge.exposeInMainWorld("loom", api);

