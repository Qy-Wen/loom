/**
 * Compaction rate = context tokens after compact / tokens before.
 *
 *   pnpm --filter @loom/agent eval:compaction-rate
 */
import { pathToFileURL } from "node:url";
import { estimateTokens, findCutPoint, type AgentMessage } from "#vendor/pi-agent";
import { userTextFromContent } from "../src/attachments.ts";

/** After / before. Smaller means more was dropped. */
export function compactionRate(tokensBefore: number, tokensAfter: number): number {
	if (tokensBefore <= 0) return 0;
	return tokensAfter / tokensBefore;
}

export type CompactionRateResult = {
	tokensBefore: number;
	tokensAfter: number;
	rate: number;
	dropped: number;
	retained: number;
};

function messageEntries(messages: AgentMessage[]) {
	return messages.map((message, index) => ({
		type: "message" as const,
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		seq: index,
		timestamp: typeof message.timestamp === "number" ? message.timestamp : index,
		message,
	}));
}

function extractiveSummary(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			const content = "content" in message ? message.content : "";
			return `${message.role}: ${userTextFromContent(content).slice(0, 80)}`;
		})
		.join("\n");
}

/** Keep a recent-token tail and replace the dropped prefix with an extractive summary. */
export function compactTranscript(messages: AgentMessage[], keepRecentTokens: number): CompactionRateResult {
	const tokensBefore = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const entries = messageEntries(messages);
	const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
	const dropped = messages.slice(0, cut.firstKeptEntryIndex);
	const retained = messages.slice(cut.firstKeptEntryIndex);
	const summary: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: extractiveSummary(dropped) }],
		timestamp: Date.now(),
	};
	const tokensAfter = (dropped.length ? estimateTokens(summary) : 0)
		+ retained.reduce((sum, message) => sum + estimateTokens(message), 0);
	return {
		tokensBefore,
		tokensAfter,
		rate: compactionRate(tokensBefore, tokensAfter),
		dropped: dropped.length,
		retained: retained.length,
	};
}

export function longTranscript(turns = 16): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < turns; index++) {
		const body = `Turn ${index}: edit clips/hero.mp4 — trim, crop, and note the cut. `.repeat(8);
		messages.push({
			role: "user",
			content: [{ type: "text", text: `请处理第 ${index} 步。${body}` }],
			timestamp: index * 2,
		});
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `已完成第 ${index} 步。${body}` }],
			timestamp: index * 2 + 1,
		} as AgentMessage);
	}
	return messages;
}

export function measureCompactionRate(keepRecentTokens = 400): CompactionRateResult {
	return compactTranscript(longTranscript(), keepRecentTokens);
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function main(): void {
	const result = measureCompactionRate();
	console.log("Compaction rate  (after / before context tokens)\n");
	console.log(`  rate   ${pct(result.rate)}   (${result.tokensAfter} / ${result.tokensBefore})`);
	console.log(`  dropped ${result.dropped} messages, retained ${result.retained}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
