import type { WebContents } from "electron";
import type { PasteChoice, ResolvePasteConflict } from "@loom/core";
import { IPC } from "../../shared/ipc.ts";

interface PendingConflict {
	senderId: number;
	settle: (choice: PasteChoice, applyAll: boolean) => void;
}

const pending = new Map<number, PendingConflict>();
let nextId = 0;

/** Only the renderer that owns a question may answer it; late replies are ignored. */
export function resolvePasteConflict(senderId: number, id: number, choice: PasteChoice, applyAll: boolean): void {
	const request = pending.get(id);
	if (request?.senderId !== senderId || !["replace", "keep-both", "cancel"].includes(choice)) return;
	request.settle(choice, applyAll === true);
}

/** Each resolver owns one batch's Apply to All choice, including nested conflicts. */
export function pasteConflictResolver(sender: WebContents, signal: AbortSignal): ResolvePasteConflict {
	let applyAll: PasteChoice | undefined;
	return async (conflict) => {
		if (signal.aborted || sender.isDestroyed()) return "cancel";
		if (applyAll) return applyAll;
		const result = await new Promise<{ choice: PasteChoice; applyAll: boolean }>((resolve) => {
			const id = ++nextId;
			const settle = (choice: PasteChoice, applyAll: boolean) => {
				pending.delete(id);
				signal.removeEventListener("abort", cancel);
				resolve({ choice, applyAll });
			};
			const cancel = () => {
				settle("cancel", false);
				if (!sender.isDestroyed()) sender.send(IPC.pasteConflict, { id, conflict: null });
			};
			pending.set(id, { senderId: sender.id, settle });
			signal.addEventListener("abort", cancel, { once: true });
			try { sender.send(IPC.pasteConflict, { id, conflict }); }
			catch {
				settle("cancel", false);
			}
		});
		if (signal.aborted) return "cancel";
		if (result.applyAll && result.choice !== "cancel") applyAll = result.choice;
		return result.choice;
	};
}
