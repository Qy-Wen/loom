import type { LoomTraceRecord } from "@loom/agent";

/** One persisted run, including task-owned specialist spans. */
export type DevTraceRecord = LoomTraceRecord;

export const DEV_TRACE_IPC = {
	open: "loom:openDevTrace",
	getTraces: "loom:getDevTraces",
	trace: "loom:devTrace",
} as const;
