import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_LOG_MAX_BYTES = 1024 * 1024;
export const APP_LOG_GENERATIONS = 3;

export function appLogDirectory(platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	if (platform === "darwin") return join(home, "Library", "Logs", "Loom");
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Loom", "logs");
	return join(home, ".config", "Loom", "logs");
}

/** Append one diagnostic line. Past {@link APP_LOG_MAX_BYTES}, rename `main.log` through `main.log.2` and start a new file. */
export function appendAppLog(directory: string, message: string, maxBytes = APP_LOG_MAX_BYTES): void {
	try {
		mkdirSync(directory, { recursive: true });
		const file = join(directory, "main.log");
		const line = `${new Date().toISOString()} ${message}\n`;
		rotateAppLog(directory, Buffer.byteLength(line), maxBytes);
		appendFileSync(file, line);
	} catch (error) {
		console.error("Could not write Loom log", error);
	}
}

function rotateAppLog(directory: string, incoming: number, maxBytes: number): void {
	const file = join(directory, "main.log");
	let size = 0;
	try {
		size = statSync(file).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (size === 0 || size + incoming <= maxBytes) return;

	const oldest = join(directory, `main.log.${APP_LOG_GENERATIONS - 1}`);
	rmSync(oldest, { force: true });
	for (let generation = APP_LOG_GENERATIONS - 2; generation >= 1; generation -= 1) {
		moveIfPresent(join(directory, `main.log.${generation}`), join(directory, `main.log.${generation + 1}`));
	}
	renameSync(file, join(directory, "main.log.1"));
}

function moveIfPresent(from: string, to: string): void {
	try {
		renameSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
