import { contextBridge, ipcRenderer } from "electron";
import { DEV_TRACE_IPC, type DevTraceMetric, type DevTraceRecord, type DevTraceConversation, type TraceCursor } from "../shared/dev-trace.ts";
import type { AppLanguageChoice } from "../shared/general-settings.ts";

const api = {
	getTraces: (before?: { at: number; id: string }): Promise<DevTraceRecord[]> => ipcRenderer.invoke(DEV_TRACE_IPC.getTraces, before),
	getTrace: (id: string): Promise<DevTraceRecord | undefined> => ipcRenderer.invoke(DEV_TRACE_IPC.getTrace, id),
	getConversations: (before?: TraceCursor): Promise<DevTraceConversation[]> => ipcRenderer.invoke(DEV_TRACE_IPC.getConversations, before),
	getConversation: (id: string, before?: TraceCursor): Promise<DevTraceRecord[]> => ipcRenderer.invoke(DEV_TRACE_IPC.getConversation, id, before),
	getMetrics: (): Promise<DevTraceMetric[]> => ipcRenderer.invoke(DEV_TRACE_IPC.getMetrics),
	getLanguage: (): Promise<AppLanguageChoice> => ipcRenderer.invoke(DEV_TRACE_IPC.getLanguage),
	onLanguageChanged: (listener: () => void): (() => void) => {
		const handler = () => listener();
		ipcRenderer.on(DEV_TRACE_IPC.language, handler);
		return () => ipcRenderer.removeListener(DEV_TRACE_IPC.language, handler);
	},
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
