import type { ConversationView, EntryId, InboxState, LiveState, SubmissionId } from "@loom/agent";

/** Completion follows fully presented state and explicit submission settlement, including coalesced watches. */
export function createConversationActivity(snapshot: ConversationView, request?: { id: SubmissionId; existedAtSnapshot: boolean }) {
	let running = (snapshot.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
	const containsRequest = (value: ConversationView) => request !== undefined &&
		((value.docs["pi.live"] as LiveState | undefined)?.run?.inputs.includes(request.id) ||
		(value.docs["pi.inbox"] as InboxState | undefined)?.items.some((item) => item.id === request.id));
	let requestSettled = request === undefined || (request.existedAtSnapshot && !containsRequest(snapshot));
	let presented = snapshot;
	let settledAt: EntryId | undefined;
	const idle = Promise.withResolvers<void>();
	const check = () => { if (requestSettled && !running && !containsRequest(presented) && (settledAt === undefined || (presented.entries.at(-1)?.id ?? presented.before ?? 0) >= settledAt)) idle.resolve(); };
	check();
	return {
		idle: idle.promise,
		settle(at?: EntryId) { requestSettled = true; settledAt = at; check(); },
		apply(view: ConversationView) {
			presented = view;
			running = (view.docs["pi.live"] as LiveState | undefined)?.run !== undefined;
			check();
		},
	};
}
