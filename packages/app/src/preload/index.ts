import { contextBridge, ipcRenderer } from "electron";
import type { LibraryChange, SessionSummary } from "@loom/core";
import { IPC, type LoomApi } from "../shared/ipc.ts";

const api: LoomApi = {
	getAgentEndpoint: () => ipcRenderer.invoke(IPC.getAgentEndpoint),
	openLibrary: () => ipcRenderer.invoke(IPC.openLibrary),
	getLibrarySnapshot: () => ipcRenderer.invoke(IPC.getLibrarySnapshot),
	showAssetContextMenu: (assetId) => ipcRenderer.invoke(IPC.showAssetContextMenu, assetId),
	renameAsset: (assetId, stem) => ipcRenderer.invoke(IPC.renameAsset, assetId, stem),
	duplicateAsset: (assetId) => ipcRenderer.invoke(IPC.duplicateAsset, assetId),
	copyAssetPath: (assetId) => ipcRenderer.invoke(IPC.copyAssetPath, assetId),
	revealAsset: (assetId) => ipcRenderer.invoke(IPC.revealAsset, assetId),
	trashAsset: (assetId) => ipcRenderer.invoke(IPC.trashAsset, assetId),
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
	analyzeAsset: (assetId) => ipcRenderer.invoke(IPC.analyzeAsset, assetId),
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
};

contextBridge.exposeInMainWorld("loom", api);
