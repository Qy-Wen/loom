import { contextBridge, ipcRenderer } from "electron";
import type { LibraryChange } from "@loom/core";
import { IPC, type LoomApi } from "../shared/ipc.ts";

const api: LoomApi = {
	getAgentEndpoint: () => ipcRenderer.invoke(IPC.getAgentEndpoint),
	openLibrary: () => ipcRenderer.invoke(IPC.openLibrary),
	getLibrarySnapshot: () => ipcRenderer.invoke(IPC.getLibrarySnapshot),
	onLibraryChanged: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, change: LibraryChange) => listener(change);
		ipcRenderer.on(IPC.libraryChanged, handler);
		return () => ipcRenderer.removeListener(IPC.libraryChanged, handler);
	},
};

contextBridge.exposeInMainWorld("loom", api);
