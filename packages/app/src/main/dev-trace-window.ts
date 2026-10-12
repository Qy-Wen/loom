import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { DEV_TRACE_IPC, type DevTraceRecord } from "../shared/dev-trace.ts";
import { loadAppIcon } from "./app-icon.ts";

const TITLE = "Traces";

let listTraces: (limit: number, before?: { at: number; id: string }) => DevTraceRecord[] = () => [];
let win: BrowserWindow | null = null;
let ipcReady = false;
let preloadPath = "";

export function publishDevTrace(record: DevTraceRecord | null): void {
	if (win && !win.isDestroyed()) win.webContents.send(DEV_TRACE_IPC.trace, record);
}

export function registerDevTraceIpc(preload: string, list: typeof listTraces): void {
	preloadPath = preload;
	listTraces = list;
	if (ipcReady) return;
	ipcReady = true;
	ipcMain.handle(DEV_TRACE_IPC.open, (): void => {
		openDevTraceWindow();
	});
	ipcMain.handle(DEV_TRACE_IPC.getTraces, (_event, before?: { at: number; id: string }): DevTraceRecord[] => {
		if (before && (!Number.isFinite(before.at) || typeof before.id !== "string")) throw new Error("Invalid trace cursor");
		return listTraces(40, before);
	});
}

export function openDevTraceWindow(): void {
	if (app.isPackaged || (!process.env.ELECTRON_RENDERER_URL && !(process.env.LOOM_E2E === "1" && process.env.LOOM_E2E_TRACE === "1")) || !preloadPath) return;
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
		backgroundColor: "#f7f7f6",
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
