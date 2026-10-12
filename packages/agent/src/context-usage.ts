import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { ContextView, ModelRef } from "./durable-adapter.ts";
import type { LoomContextUsage } from "./session-dto.ts";

/** Current active context, not cumulative spend or the full UI transcript. Mirrors durable's compaction estimate. */
export function contextUsage(view: ContextView, model: ModelRef, window: number): LoomContextUsage {
	const head = view.head?.id ?? Number.NEGATIVE_INFINITY;
	let measuredIndex = -1;
	let tokens = 0;
	for (let index = view.entries.length - 1; index >= 0 && measuredIndex < 0; index--) {
		if (view.entries[index]!.id <= head) continue;
		const message = view.contributions[index]!.findLast((message) =>
			message.role === "assistant" && message.provider === model.provider && message.model === model.modelId &&
			message.stopReason !== "aborted" && message.stopReason !== "error" && message.stopReason !== "deferred" &&
			calculateContextTokens(message.usage) > 0,
		);
		if (message?.role !== "assistant") continue;
		measuredIndex = view.messages.lastIndexOf(message);
		if (measuredIndex >= 0) tokens = calculateContextTokens(message.usage);
	}
	// Without applicable usage (new chat, compaction, model change), estimate the active messages instead.
	for (const message of view.messages.slice(measuredIndex + 1)) tokens += estimateMessageTokens(message);
	return { tokens, window, percent: tokens / window * 100 };
}
