import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Files that used to live in the Electron user-data directory. */
export const LOOM_HOME_FILES = [
	"model-settings.json",
	"chat-models.json",
	"chat-credentials.json",
	"chat-model-catalog.json",
	"device-id.json",
	"agent-stats.json",
	"last-library.json",
	"general.json",
	"agent-permission.json",
	"AGENTS.md",
	"agent-sandbox.json",
	"mcp-service.json",
	"cloud-backup.json",
	"cloud-backup-state.json",
	"mcp.json",
] as const;

export const LOOM_HOME_DIRECTORIES = ["skills", "cloud-backup-progress"] as const;

export function loomHomeDir(): string {
	return join(homedir(), ".loom");
}

/** E2E keeps the isolated user-data directory so it does not read or write the real home. */
export function loomConfigDir(e2e: boolean, userData: string): string {
	return e2e ? userData : loomHomeDir();
}

/** Move Loom settings into `toDir` when that copy is not already there. Returns the names that moved. */
export async function migrateLoomHome(fromDir: string, toDir: string): Promise<string[]> {
	if (resolve(fromDir) === resolve(toDir)) return [];
	await mkdir(toDir, { recursive: true });
	const moved: string[] = [];
	for (const name of [...LOOM_HOME_FILES, ...LOOM_HOME_DIRECTORIES]) {
		if (await moveIfAbsent(join(fromDir, name), join(toDir, name))) moved.push(name);
	}
	return moved;
}

async function moveIfAbsent(from: string, to: string): Promise<boolean> {
	if (!await exists(from) || await exists(to)) return false;
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(from, to, { recursive: true });
		await rm(from, { recursive: true, force: true });
	}
	return true;
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
