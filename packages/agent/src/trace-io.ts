import type { LoomTraceSpan } from "./run-trace.ts";

/** Tool arguments and the text returned to the model, per call id. */
export interface ToolExchange {
	args?: string;
	result?: string;
}

export const TOOL_IO_LIMIT = 8 * 1024;

export function clipTraceText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n…`;
}

export function toolArgsText(args: unknown): string {
	try {
		return clipTraceText(JSON.stringify(args, null, 2), TOOL_IO_LIMIT);
	} catch {
		return clipTraceText(String(args), TOOL_IO_LIMIT);
	}
}

/** Copy a tool's arguments and result onto the matching tool span. */
export function attachToolExchange(
	spans: readonly LoomTraceSpan[],
	byCallId: ReadonlyMap<string, ToolExchange>,
): LoomTraceSpan[] {
	return spans.map((span) => {
		if (span.name !== "pi.harness.tool") return span;
		const callId = span.attributes["pi.tool.call_id"];
		if (typeof callId !== "string") return span;
		const exchange = byCallId.get(callId);
		if (!exchange) return span;
		return {
			...span,
			attributes: {
				...span.attributes,
				...(exchange.args === undefined ? {} : { "loom.io.input": exchange.args }),
				...(exchange.result === undefined ? {} : { "loom.io.output": exchange.result }),
			},
		};
	});
}
