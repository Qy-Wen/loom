import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc.ts";
import type {
	CreateSkillInput,
	SkillScope,
	UpdateSkillInput,
} from "../../shared/skills-settings.ts";
import type { SkillsService } from "./skills-service.ts";

function assertScope(value: unknown): SkillScope {
	if (value === "user" || value === "library") return value;
	throw new Error("Invalid skill scope.");
}

function assertString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Invalid ${label}.`);
	return value;
}

export function registerSkillsIpc(getService: () => SkillsService): void {
	ipcMain.handle(IPC.getSkillsSettings, () => getService().list());

	ipcMain.handle(IPC.readSkill, (_event, scope: unknown, id: unknown) => {
		return getService().read(assertScope(scope), assertString(id, "skill id"));
	});

	ipcMain.handle(IPC.createSkill, (_event, raw: unknown) => {
		if (!raw || typeof raw !== "object") throw new Error("Invalid skill payload.");
		const input = raw as CreateSkillInput;
		return getService().create({
			scope: assertScope(input.scope),
			name: assertString(input.name, "skill name"),
			description: assertString(input.description, "skill description"),
			content: typeof input.content === "string" ? input.content : "",
		});
	});

	ipcMain.handle(IPC.saveSkill, (_event, raw: unknown) => {
		if (!raw || typeof raw !== "object") throw new Error("Invalid skill payload.");
		const input = raw as UpdateSkillInput;
		return getService().save({
			scope: assertScope(input.scope),
			id: assertString(input.id, "skill id"),
			description: assertString(input.description, "skill description"),
			content: typeof input.content === "string" ? input.content : "",
		});
	});

	ipcMain.handle(IPC.setSkillEnabled, (_event, scope: unknown, name: unknown, enabled: unknown) => {
		if (typeof enabled !== "boolean") throw new Error("Invalid enabled flag.");
		return getService().setEnabled(assertScope(scope), assertString(name, "skill name"), enabled);
	});

	ipcMain.handle(IPC.deleteSkill, (_event, scope: unknown, id: unknown) => {
		return getService().delete(assertScope(scope), assertString(id, "skill id"));
	});

	ipcMain.handle(IPC.openSkillsFolder, (_event, scope: unknown, targetPath?: unknown) => {
		if (targetPath !== undefined && typeof targetPath !== "string") throw new Error("Invalid target path.");
		return getService().openFolder(assertScope(scope), targetPath);
	});
}
