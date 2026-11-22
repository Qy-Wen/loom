/** Something with edits not yet on disk. The window waits for these before it closes or a backup starts. */
export interface PendingSave {
	readonly assetId: string;
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

/** Write pending edits, optionally for one asset. Rejects when a save fails. */
export async function flushPendingSaves(assetId?: string): Promise<void> {
	const saves = [...pending].filter((save) => assetId === undefined || save.assetId === assetId);
	await Promise.all(saves.map((save) => save.flush()));
}
