import { useSyncExternalStore } from "react";

const pending = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** The main process paused this tool call for Approve / Skip. */
export function setToolGatePending(toolCallId: string, waiting: boolean): void {
	const changed = waiting ? !pending.has(toolCallId) : pending.has(toolCallId);
	if (!changed) return;
	if (waiting) pending.add(toolCallId);
	else pending.delete(toolCallId);
	emit();
}

export function useToolGatePending(toolCallId: string | undefined): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => toolCallId !== undefined && pending.has(toolCallId),
	);
}
