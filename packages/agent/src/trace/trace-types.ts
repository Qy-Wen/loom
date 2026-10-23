import type { StoredSpan } from "@earendil-works/pi-telemetry";

/** Native span snapshot, also available before settlement for live and crash diagnostics. */
export type LoomTraceSpan = Omit<StoredSpan, "endedMs"> & {
	readonly endedMs?: number;
	readonly interrupted?: boolean;
};
