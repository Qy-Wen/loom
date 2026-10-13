export const DEFAULT_PROCESS_SANDBOX = true;

export interface ProcessSandboxNotice {
	id: string;
	reason: string;
}

export function parseProcessSandboxEnabled(value: unknown): boolean {
	return typeof value === "boolean" ? value : DEFAULT_PROCESS_SANDBOX;
}

/** Full permission runs bash and ffmpeg directly, even when the setting is on. */
export function processSandboxActive(settingEnabled: boolean, permission: string): boolean {
	return settingEnabled && permission !== "full";
}
