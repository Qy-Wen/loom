import type { LoomSessionSummary } from "@loom/agent";

export interface SessionTabUnreadState {
	readonly busyIds: ReadonlySet<string>;
	readonly unreadIds: ReadonlySet<string>;
}

export const emptySessionTabUnreadState: SessionTabUnreadState = {
	busyIds: new Set(),
	unreadIds: new Set(),
};

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const value of a) {
		if (!b.has(value)) return false;
	}
	return true;
}

/** Track open background sessions that finished running while another tab was active. */
export function reconcileSessionTabUnread(
	state: SessionTabUnreadState,
	sessions: readonly LoomSessionSummary[],
	currentId: string | null,
): SessionTabUnreadState {
	const nextBusyIds = new Set<string>();
	const nextUnreadIds = new Set<string>();

	for (const session of sessions) {
		if (session.status !== "open") continue;
		if (session.busy) {
			nextBusyIds.add(session.id);
			continue;
		}
		if (session.id === currentId) continue;
		if (state.unreadIds.has(session.id) || state.busyIds.has(session.id)) {
			nextUnreadIds.add(session.id);
		}
	}

	if (sameSet(state.busyIds, nextBusyIds) && sameSet(state.unreadIds, nextUnreadIds)) {
		return state;
	}
	return { busyIds: nextBusyIds, unreadIds: nextUnreadIds };
}
