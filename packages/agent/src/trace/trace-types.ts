import type { StoredMetric, StoredSpan } from "@earendil-works/pi-telemetry";

/** Native span snapshot, also available before settlement for live and crash diagnostics. */
export type LoomTraceSpan = Omit<StoredSpan, "endedMs"> & {
	readonly endedMs?: number;
	readonly interrupted?: boolean;
};

/** Ten-second aggregation with instrument metadata, non-cumulative buckets, and bounded exemplars. */
export type LoomTraceMetric = StoredMetric & {
	readonly description?: string;
	readonly boundaries?: readonly number[];
	readonly bucketCounts?: readonly number[];
	readonly exemplars?: readonly {
		readonly value: number;
		readonly at: number;
		readonly traceId: string;
		readonly spanId: string;
	}[];
};
