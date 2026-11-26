type WorkspacePreference = "workbench" | "activeSession";

function storageKey(root: string, preference: WorkspacePreference): string {
	return `loom.workspace.${preference}:${root}`;
}

export function readWorkspacePreference(root: string, preference: WorkspacePreference): unknown {
	try {
		const value = localStorage.getItem(storageKey(root, preference));
		return value === null ? null : JSON.parse(value);
	} catch {
		return null;
	}
}

export function writeWorkspacePreference(root: string, preference: WorkspacePreference, value: unknown): void {
	try {
		localStorage.setItem(storageKey(root, preference), JSON.stringify(value));
	} catch { /* Workspace preferences are optional. */ }
}
