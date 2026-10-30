import type { LoomTraceMetric, LoomTraceRecord } from "@loom/agent";

/** One persisted run, including task-owned specialist spans. */
export type DevTraceRecord = LoomTraceRecord;
export type DevTraceMetric = LoomTraceMetric;
export type { LoomTraceConversation as DevTraceConversation } from "@loom/agent/durable";
export type TraceCursor = { at: number; id: string };

export const DEV_TRACE_IPC = {
	open: "loom:openDevTrace",
	getTraces: "loom:getDevTraces",
	getTrace: "loom:getDevTrace",
	getConversations: "loom:getDevTraceConversations",
	getConversation: "loom:getDevTraceConversation",
	getMetrics: "loom:getDevTraceMetrics",
	trace: "loom:devTrace",
} as const;
