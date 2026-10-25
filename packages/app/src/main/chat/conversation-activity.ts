import type { AgentEvent, SnapshotEvent, SubmissionId } from "@loom/agent";

/** Completion follows the state of fully presented commit batches. */
export function createConversationActivity(snapshot: SnapshotEvent, request?: { id: SubmissionId; existedAtSnapshot: boolean }) {
	let running = snapshot.run !== undefined;
	const containsRequest = (value: SnapshotEvent) => request !== undefined &&
		(value.run?.inputs.includes(request.id) || value.inbox.some((item) => item.id === request.id));
	let requestSettled = request === undefined || (request.existedAtSnapshot && !containsRequest(snapshot));
	const idle = Promise.withResolvers<void>();
	// Runnable follow-ups start in the same commit that ends their predecessor. An inbox without a run is paused.
	const check = () => { if (requestSettled && !running) idle.resolve(); };
	check();
	return {
		idle: idle.promise,
		apply(batch: readonly AgentEvent[]) {
			for (const event of batch) {
				switch (event.type) {
					case "snapshot":
						running = event.run !== undefined;
						// Later snapshots replace dropped batches, including request settlement events.
						requestSettled = !containsRequest(event);
						break;
					case "run_start": running = true; break;
					case "run_end": running = false; break;
					case "submission":
						if (event.record.id === request?.id) requestSettled = event.record.status === "done" || event.record.status === "unanswered";
						break;
				}
			}
			check();
		},
	};
}
