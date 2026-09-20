import { contextBridge, ipcRenderer } from "electron";
import { IPC, type LoomApi } from "../shared/ipc.ts";

const api: LoomApi = {
	getAgentEndpoint: () => ipcRenderer.invoke(IPC.getAgentEndpoint),
};

contextBridge.exposeInMainWorld("loom", api);
