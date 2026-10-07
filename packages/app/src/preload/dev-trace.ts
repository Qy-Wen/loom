import { contextBridge, ipcRenderer } from "electron";
import { DEV_TRACE_IPC, type DevTraceRecord } from "../shared/dev-trace.ts";

const api = {
	getTraces: (): Promise<DevTraceRecord[]> => ipcRenderer.invoke(DEV_TRACE_IPC.getTraces),
	onTrace: (listener: (record: DevTraceRecord) => void): (() => void) => {
		const handler = (_event: Electron.IpcRendererEvent, record: DevTraceRecord) => listener(record);
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
