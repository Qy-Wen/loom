/** Lifetime Chat usage, same fields pi SessionStats.usage tracks. */
export type AgentUsageTotals = {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type AgentStatsView = AgentUsageTotals & {
	/** input + cacheRead + cacheWrite */
	promptTokens: number;
	/** cacheRead / promptTokens */
	cacheHit: number;
};

export function emptyUsageTotals(): AgentUsageTotals {
	return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function promptTokens(usage: Pick<AgentUsageTotals, "input" | "cacheRead" | "cacheWrite">): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function cacheHitRate(usage: Pick<AgentUsageTotals, "input" | "cacheRead" | "cacheWrite">): number {
	const prompt = promptTokens(usage);
	return prompt === 0 ? 0 : usage.cacheRead / prompt;
}

export function statsView(totals: AgentUsageTotals): AgentStatsView {
	return {
		...totals,
		promptTokens: promptTokens(totals),
		cacheHit: cacheHitRate(totals),
	};
}

export function addUsage(left: AgentUsageTotals, right: Omit<AgentUsageTotals, "turns"> & { turns?: number }): AgentUsageTotals {
	return {
		turns: left.turns + (right.turns ?? 1),
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
	};
}

export function usageFromMessage(message: Record<string, unknown> | undefined): Omit<AgentUsageTotals, "turns"> | undefined {
	if (!message || message.role !== "assistant") return undefined;
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const row = usage as Record<string, unknown>;
	const input = asFinite(row.input);
	if (input === undefined) return undefined;
	return {
		input,
		output: asFinite(row.output) ?? 0,
		cacheRead: asFinite(row.cacheRead) ?? 0,
		cacheWrite: asFinite(row.cacheWrite) ?? 0,
	};
}

export function usagesFromMessages(messages: readonly unknown[]): AgentUsageTotals {
	let totals = emptyUsageTotals();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const usage = usageFromMessage(message as Record<string, unknown>);
		if (usage) totals = addUsage(totals, usage);
	}
	return totals;
}

function asFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
