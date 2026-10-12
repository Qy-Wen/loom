import type { SpanAttributes, SpanStatus } from "@earendil-works/pi-telemetry";

/** Shared span DTO for durable diagnostics, persistence, and the dev-trace UI. */
export interface LoomTraceSpan {
	readonly id: number;
	readonly parentId: number | null;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly status: SpanStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
}
