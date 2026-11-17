import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type { CloudBackupView, CloudJob } from "../../shared/cloud-backup.ts";
import type { CloudBackupController } from "./controller.ts";

export function publishCloudBackup(view: CloudBackupView): void {
	for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(IPC.cloudBackupChanged, view);
}
export function registerCloudBackupIpc(controller: CloudBackupController): void {
	ipcMain.handle(IPC.getCloudBackup, () => controller.view());
	ipcMain.handle(IPC.getCloudBackupConfig, () => controller.configuration());
	ipcMain.handle(IPC.saveCloudBackup, (_event, config) => controller.save(config));
	ipcMain.handle(IPC.startCloudBackup, (_event, operation: CloudJob["operation"], libraryId?: string) => {
		if (!["backup", "preview", "restore", "test", "list"].includes(operation) || (libraryId !== undefined && typeof libraryId !== "string")) throw new Error("Invalid cloud backup operation");
		return controller.start(operation, libraryId);
	});
	ipcMain.handle(IPC.cancelCloudBackup, () => controller.cancel());
	ipcMain.handle(IPC.openRestoredCloudBackup, () => controller.openRestored());
}
