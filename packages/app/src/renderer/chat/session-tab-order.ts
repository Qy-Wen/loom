import type { LoomSessionSummary } from "@loom/agent";
import { readWorkspacePreference } from "../library/workspace-storage.ts";

export function readSessionTabOrder(root: string | null): readonly string[] {
	const value = root && readWorkspacePreference(root, "sessionTabOrder");
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** Unranked tabs keep the existing newest-first order and appear before the saved tabs. */
export function orderedOpenSessions(sessions: readonly LoomSessionSummary[], order: readonly string[]): LoomSessionSummary[] {
	const remaining = new Map(sessions.filter((session) => session.status === "open").map((session) => [session.id, session]));
	const ranked = order.flatMap((id) => {
		const session = remaining.get(id);
		remaining.delete(id);
		return session ? [session] : [];
	});
	return [...remaining.values(), ...ranked];
}
