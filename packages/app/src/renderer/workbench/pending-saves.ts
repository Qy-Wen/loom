/** Something with edits not yet on disk. The window waits for these before it closes or a backup starts. */
export interface PendingSave {
	flush(): Promise<void>;
}

const pending = new Set<PendingSave>();

/** Mark a save as holding edits. Tells the main process the first time, so it can hold the window open. */
export function addPendingSave(save: PendingSave): void {
	if (!pending.size) window.loom.setCanvasDirty(true);
	pending.add(save);
}

export function removePendingSave(save: PendingSave): void {
	if (pending.delete(save) && !pending.size) window.loom.setCanvasDirty(false);
}

/** Write every edit not yet saved. Rejects when one of them cannot be written. */
export async function flushPendingSaves(): Promise<void> {
	await Promise.all([...pending].map((save) => save.flush()));
}
