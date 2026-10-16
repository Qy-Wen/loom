import { useEffect, useRef } from "react";
import type { AbstractAgent } from "@ag-ui/client";
import { useAgent } from "@copilotkit/react-core/v2";
import { adoptMessageId } from "../../shared/ag-ui-messages.ts";

const configured = new WeakSet<AbstractAgent>();

/** The agent owns transient output only; durable owns model context and committed history. */
export function useChatStream(onHistoryChanged: () => void): void {
	const { agent } = useAgent({ updates: [] });
	const onHistory = useRef(onHistoryChanged);
	onHistory.current = onHistoryChanged;
	useEffect(() => {
		if (!configured.has(agent)) {
			agent.use((input, next) => {
				const user = input.messages.findLast((message) => message.role === "user");
				return next.run({ ...input, messages: user ? [user] : [] });
			});
			configured.add(agent);
		}
		const subscription = agent.subscribe({
			onMessagesSnapshotEvent({ event }) {
				// An attachment starts a new transient view. Do not retain another thread's reasoning/activity.
				return { messages: event.messages, stopPropagation: true };
			},
			onCustomEvent({ event, messages }) {
				if (event.name === "loom.history_changed") {
					if (event.value?.threadId === agent.threadId) onHistory.current();
					return;
				}
				if (event.name !== "loom.user_entry" && event.name !== "loom.adopt_entry") return;
				const { entryId, fromId } = event.value ?? {};
				if (typeof entryId !== "string" || typeof fromId !== "string") return;
				const next = adoptMessageId(messages, fromId, entryId);
				if (next) return { messages: next };
			},
		});
		return () => subscription.unsubscribe();
	}, [agent]);
}
