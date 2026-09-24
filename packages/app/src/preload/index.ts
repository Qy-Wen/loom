import { contextBridge, ipcRenderer } from "electron";
import type { LibraryChange } from "@loom/core";
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
	onLibraryChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, change: LibraryChange) => listener(change);
		ipcRenderer.on(IPC.libraryChanged, handler);
		return () => ipcRenderer.removeListener(IPC.libraryChanged, handler);
	},
};

contextBridge.exposeInMainWorld("loom", api);
