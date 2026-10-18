import { useSyncExternalStore } from "react";
import type { CommandAllowView } from "@loom/agent/tool-permission";

let state: CommandAllowView = { allows: [], libraryOpen: false, root: null };
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

export function setCommandAllows(next: CommandAllowView): void {
	state = { allows: next.allows, libraryOpen: next.libraryOpen, root: next.root };
	emit();
}

export function useCommandAllows(): CommandAllowView {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => state,
	);
}
