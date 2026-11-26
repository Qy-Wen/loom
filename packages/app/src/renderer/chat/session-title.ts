import type { LoomSessionSummary } from "@loom/agent";

export function sessionTitle(session: LoomSessionSummary, untitled: string): string {
	return !session.titleIsCustom && session.title === "New session" ? untitled : session.title;
}
