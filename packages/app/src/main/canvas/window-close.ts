import { app, ipcMain, type BrowserWindow, type Event, type IpcMainEvent } from "electron";
import { IPC } from "../../shared/ipc.ts";

/** Keep the renderer alive long enough to save edits when the OS closes the workspace. */
export function saveCanvasBeforeWindowClose(win: BrowserWindow): void {
	const sender = win.webContents;
	let dirty = false;
	let request: "window" | "app" | null = null;
	const pending = (event: IpcMainEvent, value: unknown) => {
		if (event.sender === sender && typeof value === "boolean") dirty = value;
	};
	const ready = (event: IpcMainEvent, success: unknown) => {
		if (event.sender !== sender || !request) return;
		const action = request;
		request = null;
		if (success !== true) return;
		dirty = false;
		if (action === "app") app.quit();
		else win.close();
	};
	const defer = (event: Event, action: "window" | "app") => {
		if (!dirty && !request) return;
		event.preventDefault();
		if (!request) {
			request = action;
			sender.send(IPC.flushCanvasBeforeClose);
		} else if (action === "app") {
			request = "app";
		}
	};
	const quit = (event: Event) => defer(event, "app");
	ipcMain.on(IPC.canvasDirtyChanged, pending);
	ipcMain.on(IPC.canvasCloseReady, ready);
	app.on("before-quit", quit);
	win.on("close", (event) => defer(event, "window"));
	win.webContents.on("render-process-gone", () => { dirty = false; request = null; });
	win.once("closed", () => {
		ipcMain.off(IPC.canvasDirtyChanged, pending);
		ipcMain.off(IPC.canvasCloseReady, ready);
		app.off("before-quit", quit);
	});
}
