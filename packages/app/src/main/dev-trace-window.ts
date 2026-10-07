import { app, BrowserWindow, ipcMain } from "electron";
import { DEV_TRACE_IPC, type DevTraceRecord } from "../shared/dev-trace.ts";

const MAX_TRACES = 40;
const TITLE = "Traces";

const records: DevTraceRecord[] = [];
let win: BrowserWindow | null = null;
let ipcReady = false;
let preloadPath = "";

export function publishDevTrace(record: DevTraceRecord): void {
	records.push(record);
	if (records.length > MAX_TRACES) records.shift();
	if (win && !win.isDestroyed()) win.webContents.send(DEV_TRACE_IPC.trace, record);
}

export function registerDevTraceIpc(preload: string): void {
	preloadPath = preload;
	if (ipcReady) return;
	ipcReady = true;
	ipcMain.handle(DEV_TRACE_IPC.open, (): void => {
		openDevTraceWindow();
	});
	ipcMain.handle(DEV_TRACE_IPC.getTraces, (): DevTraceRecord[] => records.slice());
}

export function openDevTraceWindow(): void {
	if (app.isPackaged || !process.env.ELECTRON_RENDERER_URL || !preloadPath) return;
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
		backgroundColor: "#f7f7f6",
		webPreferences: {
			preload: preloadPath,
			sandbox: false,
		},
	});
	win.on("closed", () => {
		win = null;
	});
	void win.loadURL(new URL("dev-trace.html", process.env.ELECTRON_RENDERER_URL).href);
}
