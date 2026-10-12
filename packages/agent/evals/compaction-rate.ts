/** Native durable manual compaction with a deterministic summarizer (no API spend). */
import { pathToFileURL } from "node:url";
import { createModels } from "@earendil-works/pi-ai/models";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context, MemoryStorage, createRegistry, Harness } from "../src/durable.ts";

export const compactionRate = (before: number, after: number) => before <= 0 ? 0 : after / before;
export type CompactionRateResult = { tokensBefore: number; tokensAfter: number; rate: number; dropped: number; retained: number };
export function longTranscript(turns = 16): Message[] {
	return Array.from({ length: turns }, (_, index) => [
		{ role: "user" as const, content: `Turn ${index}: edit clips/hero.mp4 — trim, crop, and note the cut. `.repeat(8), timestamp: index * 2 },
		{ ...fauxAssistantMessage(`Completed turn ${index}. `.repeat(24)), timestamp: index * 2 + 1 },
	]).flat();
}
export async function compactTranscript(messages: Message[], keepRecentTokens: number): Promise<CompactionRateResult> {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry(), settings: { compaction: { enabled: false, keepRecentTokens } } }, context);
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.models[0].provider, modelId: faux.models[0].id } } }, context);
		await conversation.commit(async (tx) => { for (const message of messages) await tx.appendEntry(conversation.id, { kind: "eval.message", model: [message] }); }, context);
		faux.setResponses([fauxAssistantMessage("The user is editing clips/hero.mp4: trim, crop, and note each cut. Continue the remaining steps.")]);
		harness.resume();
		const task = await conversation.compact(undefined, context);
		const outcome = await harness.waitForTask(task, context);
		if (outcome.state.outcome.status !== "completed") throw new Error(`Compaction ${outcome.state.outcome.status}`);
		const after = await conversation.context(context);
		const retained = after.entries.filter((entry) => entry.kind === "eval.message").length;
		const tokensBefore = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		const tokensAfter = after.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		return { tokensBefore, tokensAfter, rate: compactionRate(tokensBefore, tokensAfter), dropped: messages.length - retained, retained };
	} finally { await harness.close(context); }
}
export const measureCompactionRate = (keepRecentTokens = 400) => compactTranscript(longTranscript(), keepRecentTokens);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(await measureCompactionRate());
