import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import { CLOUD_PROVIDER_IDS, type CloudBackupView, type CloudJob, type CloudProviderId } from "../../shared/cloud-backup.ts";
import type { CloudBackupController } from "./controller.ts";

export function publishCloudBackup(view: CloudBackupView): void {
	for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(IPC.cloudBackupChanged, view);
}
export function registerCloudBackupIpc(controller: CloudBackupController): void {
	ipcMain.handle(IPC.getCloudBackup, () => controller.view());
	ipcMain.handle(IPC.getCloudBackupConfig, (_event, provider?: CloudProviderId) => {
		if (provider !== undefined && !CLOUD_PROVIDER_IDS.some((id) => id === provider)) throw new Error("Unsupported cloud provider");
		return controller.configuration(provider);
	});
	ipcMain.handle(IPC.saveCloudBackup, (_event, config) => controller.save(config));
	ipcMain.handle(IPC.startCloudBackup, (_event, operation: CloudJob["operation"], libraryId?: string, revision?: string) => {
		if (!["backup", "preview", "pull", "restore", "delete", "test", "list"].includes(operation) || (libraryId !== undefined && typeof libraryId !== "string") || (revision !== undefined && typeof revision !== "string")) throw new Error("Invalid cloud backup operation");
		return controller.start(operation, libraryId, revision);
	});
	ipcMain.handle(IPC.cancelCloudBackup, () => controller.cancel());
	ipcMain.handle(IPC.resolveCloudPull, (_event, id, choices) => {
		if (typeof id !== "string") throw new Error("Invalid pull preview ID");
		return controller.resolvePull(id, choices);
	});
	ipcMain.handle(IPC.openRestoredCloudBackup, () => controller.openRestored());
}
