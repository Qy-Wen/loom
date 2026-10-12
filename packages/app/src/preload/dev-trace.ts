import { contextBridge, ipcRenderer } from "electron";
import { DEV_TRACE_IPC, type DevTraceRecord } from "../shared/dev-trace.ts";

const api = {
	getTraces: (before?: { at: number; id: string }): Promise<DevTraceRecord[]> => ipcRenderer.invoke(DEV_TRACE_IPC.getTraces, before),
	onTrace: (listener: (record: DevTraceRecord | null) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, record: DevTraceRecord | null) => listener(record);
		ipcRenderer.on(DEV_TRACE_IPC.trace, handler);
		return () => ipcRenderer.removeListener(DEV_TRACE_IPC.trace, handler);
	},
};

contextBridge.exposeInMainWorld("loomDev", api);

declare global {
	interface Window {
		loomDev: typeof api;
	}
}
