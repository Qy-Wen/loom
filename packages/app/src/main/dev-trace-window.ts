import { app, BrowserWindow, ipcMain } from "electron";
import { windowColors } from "./appearance.ts";
import { dirname, join } from "node:path";
import { DEV_TRACE_IPC, type DevTraceMetric, type DevTraceRecord, type DevTraceConversation, type TraceCursor } from "../shared/dev-trace.ts";
import type { AppLanguageChoice } from "../shared/general-settings.ts";
import { loadAppIcon } from "./desktop/app-icon.ts";

const TITLE = "Traces";

type TraceSource = {
	listTraces(limit: number, before?: { at: number; id: string }): DevTraceRecord[];
	getTrace(id: string): DevTraceRecord | undefined;
	listConversations(before?: TraceCursor): Promise<DevTraceConversation[]>;
	getConversation(id: string, before?: TraceCursor): DevTraceRecord[];
	listMetrics(): DevTraceMetric[];
	/** The saved interface language choice; the window resolves "system" itself, as the main window does. */
	language(): Promise<AppLanguageChoice>;
};
let source: TraceSource = { listTraces: () => [], getTrace: () => undefined, listConversations: async () => [], getConversation: () => [], listMetrics: () => [], language: async () => "system" };
function validateCursor(before?: TraceCursor): void {
	if (before && (!Number.isFinite(before.at) || typeof before.id !== "string" || before.id.length > 240)) throw new Error("Invalid trace cursor");
}
function validateId(id: string): void {
	if (typeof id !== "string" || !id || id.length > 240) throw new Error("Invalid trace ID");
}
let win: BrowserWindow | null = null;
let ipcReady = false;
let preloadPath = "";

export function publishDevTrace(record: DevTraceRecord | null): void {
	if (win && !win.isDestroyed()) win.webContents.send(DEV_TRACE_IPC.trace, record);
}

/** The trace window follows the interface language; tell it when the language is changed in Settings. */
export function publishDevTraceLanguage(): void {
	if (win && !win.isDestroyed()) win.webContents.send(DEV_TRACE_IPC.language);
}

export function registerDevTraceIpc(preload: string, queries: TraceSource): void {
	preloadPath = preload;
	source = queries;
	if (ipcReady) return;
	ipcReady = true;
	ipcMain.handle(DEV_TRACE_IPC.open, (): void => {
		openDevTraceWindow();
	});
	ipcMain.handle(DEV_TRACE_IPC.getTraces, (_event, before?: { at: number; id: string }): DevTraceRecord[] => {
		validateCursor(before);
		return source.listTraces(40, before);
	});
	ipcMain.handle(DEV_TRACE_IPC.getTrace, (_event, id: string): DevTraceRecord | undefined => {
		validateId(id);
		return source.getTrace(id);
	});
	ipcMain.handle(DEV_TRACE_IPC.getConversations, (_event, before?: TraceCursor) => { validateCursor(before); return source.listConversations(before); });
	ipcMain.handle(DEV_TRACE_IPC.getConversation, (_event, id: string, before?: TraceCursor) => { validateId(id); validateCursor(before); return source.getConversation(id, before); });
	ipcMain.handle(DEV_TRACE_IPC.getMetrics, (): DevTraceMetric[] => source.listMetrics());
	ipcMain.handle(DEV_TRACE_IPC.getLanguage, () => source.language());
}

export function openDevTraceWindow(): void {
	if (!preloadPath) return;
	if (win && !win.isDestroyed()) {
		win.show();
		win.focus();
		return;
	}
	const main = BrowserWindow.getAllWindows().find((window) => window.getTitle() !== TITLE);
	const origin = main?.getPosition();
	win = new BrowserWindow({
		width: 980,
		height: 720,
		minWidth: 720,
		minHeight: 480,
		x: origin ? origin[0] + 40 : undefined,
		y: origin ? origin[1] + 40 : undefined,
		title: TITLE,
		icon: loadAppIcon(),
		backgroundColor: windowColors().background,
		webPreferences: {
			preload: preloadPath,
			sandbox: false,
		},
	});
	win.on("closed", () => {
		win = null;
	});
	if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(new URL("dev-trace.html", process.env.ELECTRON_RENDERER_URL).href);
	else void win.loadFile(join(dirname(preloadPath), "../renderer/dev-trace.html"));
}
