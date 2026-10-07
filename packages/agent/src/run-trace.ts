import type {
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";

export interface LoomTraceSpan {
	readonly id: number;
	readonly parentId: number | null;
	readonly name: string;
	readonly attributes: Readonly<SpanAttributes>;
	readonly status: SpanStatus;
	readonly startedAt: number;
	readonly endedAt?: number;
}

interface MutableSpan {
	id: number;
	parentId: number | null;
	name: string;
	attributes: SpanAttributes;
	status: SpanStatus;
	startedAt: number;
	endedAt?: number;
	settled: boolean;
}

/**
 * One prompt's span tree. Records start and end times because pi's in-memory
 * recorder does not. Lives only for that prompt.
 */
export class LoomTelemetryContext implements TelemetryContext {
	private readonly spans: MutableSpan[] = [];
	private nextId = 1;

	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		return this.open(undefined, options, callback);
	}

	getSpans(): readonly LoomTraceSpan[] {
		return this.spans.map((span) => ({
			id: span.id,
			parentId: span.parentId,
			name: span.name,
			attributes: { ...span.attributes },
			status: span.status.status === "ok" ? { status: "ok" } : { ...span.status },
			startedAt: span.startedAt,
			...(span.endedAt === undefined ? {} : { endedAt: span.endedAt }),
		}));
	}

	private open<T>(parent: MutableSpan | undefined, options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
		if (parent?.settled) return Promise.resolve(callback(noopSpan));
		const recorded: MutableSpan = {
			id: this.nextId++,
			parentId: parent?.id ?? null,
			name: options.name,
			attributes: copyAttributes(options.attributes),
			status: { status: "ok" },
			startedAt: Date.now(),
			settled: false,
		};
		this.spans.push(recorded);
		const span = this.spanApi(recorded);
		let result: T | Promise<T>;
		try {
			result = callback(span);
		} catch (error) {
			this.settle(recorded, error);
			return Promise.reject(error);
		}
		return Promise.resolve(result).then(
			(value) => {
				this.settle(recorded);
				return value;
			},
			(error: unknown) => {
				this.settle(recorded, error);
				throw error;
			},
		);
	}

	private spanApi(recorded: MutableSpan): TelemetrySpan {
		return {
			startSpan: (options, callback) => this.open(recorded, options, callback),
			addEvent() {},
			setAttributes: (attributes) => {
				if (recorded.settled) return;
				recorded.attributes = { ...recorded.attributes, ...copyAttributes(attributes) };
			},
			setStatus: (status) => {
				if (recorded.settled) return;
				recorded.status = status.status === "ok" ? { status: "ok" } : { ...status };
			},
		};
	}

	private settle(span: MutableSpan, error?: unknown): void {
		if (span.settled) return;
		span.settled = true;
		span.endedAt = Date.now();
		if (error !== undefined && span.status.status !== "error") {
			span.status = error instanceof Error
				? { status: "error", error: { name: error.name, message: error.message } }
				: { status: "error" };
		}
	}
}

const noopSpan: TelemetrySpan = {
	startSpan: (_options, callback) => Promise.resolve(callback(noopSpan)),
	addEvent() {},
	setAttributes() {},
	setStatus() {},
};

function copyAttributes(attributes: SpanAttributes | undefined): SpanAttributes {
	const copy: SpanAttributes = {};
	if (!attributes) return copy;
	for (const [name, value] of Object.entries(attributes)) {
		if (value !== undefined) copy[name] = Array.isArray(value) ? [...value] : value;
	}
	return copy;
}
