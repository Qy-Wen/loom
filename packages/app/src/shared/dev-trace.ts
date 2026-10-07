import type { LoomTraceSpan } from "@loom/agent";

/** One prompt's spans, kept in the dev window for this process only. */
export interface DevTraceRecord {
	id: string;
	threadId: string;
	at: number;
	spans: LoomTraceSpan[];
}

export const DEV_TRACE_IPC = {
	open: "loom:openDevTrace",
	getTraces: "loom:getDevTraces",
	trace: "loom:devTrace",
} as const;
