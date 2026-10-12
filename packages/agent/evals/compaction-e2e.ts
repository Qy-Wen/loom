/**
 * Threshold-compaction eval against a real Chat endpoint.
 *
 *   pnpm --filter @loom/agent eval:compaction-e2e
 *
 * Drives a real model with a deliberately small contextWindow so threshold
 * compaction fires mid-conversation, then checks:
 *   1. a compaction entry lands in the session
 *   2. the estimated active context drops after compaction
 *   3. the summary keeps anchor facts the later turns can still recall
 */
import { pathToFileURL } from "node:url";
import { CompactionEntry, watchEvents, type AgentEvent } from "../src/durable.ts";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { userTextFromContent } from "../src/attachments.ts";
import { openEvalAgent, context } from "./runtime.ts";

/** Deliberately small so a few fat turns cross window - reserve. */
const CONTEXT_WINDOW = 100_000;
/** Roughly half the window per turn; three turns cross the threshold. */
const PAD_CHARS = 55_000;

const ANCHOR = {
	code: "LOOM-7F3K",
	path: "projects/aurora/main.mp4",
	color: "teal",
};

function filler(turn: number): string {
	return `Turn ${turn} context: `.padEnd(48, "-") + "编辑素材库里的长镜头，标记入出点，应用调色预设。".repeat(PAD_CHARS / 30);
}

export type CompactionE2EResult = {
	window: number;
	compactionEvents: number;
	contextBefore: number | null;
	contextAfterCompaction: number | null;
	summary: string;
	summaryMentionsCode: boolean;
	summaryMentionsPath: boolean;
	recallAnswer: string;
	turns: number;
};

export async function runCompactionE2E(
	chat: { baseUrl: string; apiKey?: string; model: string },
	options: { window?: number; turns?: number } = {},
): Promise<CompactionE2EResult> {
	const window = options.window ?? CONTEXT_WINDOW;
	const turns = options.turns ?? 4;
	const runtime = await openEvalAgent({ ...chat, contextWindow: window }, {
		systemPrompt: "You are Loom. Answer briefly in one sentence. Do not call tools.",
		settings: { compaction: { reserveTokens: Math.min(16_384, Math.floor(window / 4)), keepRecentTokens: Math.min(4000, Math.floor(window / 8)), backgroundTokens: 0 } },
	});
	const events: AgentEvent[] = [];
	let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
	try {
		const conversation = await runtime.owner.createConversation({}, context);
		stream = await watchEvents(runtime.owner.harness, conversation.id, context);
		stream.start(async (batch) => { events.push(...batch); });
		const prompt = async (content: string) => {
			if ((await (await conversation.submit({ type: "input", content }, context)).wait(context)).status !== "done") throw new Error("Compaction eval request failed");
		};
		let lastContext: number | null = null;
		let contextBefore: number | null = null;
		let contextAfterCompaction: number | null = null;

		for (let turn = 0; turn < turns; turn++) {
			const anchor = turn === 0
				? ` Remember for the whole session: the project code is ${ANCHOR.code}, the main file is ${ANCHOR.path}, and the theme color is ${ANCHOR.color}.`
				: "";
			await prompt(`${filler(turn)}${anchor}`);
			const active = await conversation.context(context);
			const usage = active.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
			const compacted = active.entries.some((entry) => CompactionEntry.is(entry));
			// First concrete reading after a compaction reflects the compacted context.
			if (compacted && contextAfterCompaction === null && usage !== null && usage < (lastContext ?? Infinity)) {
				contextAfterCompaction = usage;
				contextBefore = lastContext;
			}
			if (usage !== null) lastContext = usage;
		}

		// Recall probe: can the model still name the anchors after compaction?
		await prompt("One line: what is the project code, main file, and theme color?");
		const final = await conversation.context(context);
		const recallAnswer = userTextFromContent(final.messages.findLast((message) => message.role === "assistant")?.content);
		const summaries = final.entries.filter((entry) => CompactionEntry.is(entry));
		const summary = summaries.map((entry) => userTextFromContent(entry.model?.[0]?.content)).join("\n");
		return {
			window,
			compactionEvents: events.filter((event) => event.type === "compaction_end" && !event.error).length,
			contextBefore: contextBefore ?? lastContext,
			contextAfterCompaction,
			summary,
			summaryMentionsCode: summary.includes(ANCHOR.code),
			summaryMentionsPath: summary.includes(ANCHOR.path),
			recallAnswer,
			turns,
		};
	} finally {
		await stream?.stop(); await runtime.close();
	}
}

export function chatFromEnv(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey?: string; model: string } | undefined {
	const apiKey = env.DEEPSEEK_API_KEY?.trim();
	if (!apiKey) return undefined;
	return {
		baseUrl: env.LOOM_CHAT_BASE_URL?.trim() || "https://api.deepseek.com",
		model: env.LOOM_CHAT_MODEL?.trim() || "deepseek-v4-flash",
		apiKey,
	};
}

async function main(): Promise<void> {
	const chat = chatFromEnv();
	if (!chat) throw new Error("DEEPSEEK_API_KEY is required for the compaction eval.");
	console.log("Threshold compaction (real model)\n");
	console.log(`  ${chat.baseUrl}  ${chat.model}  window=${CONTEXT_WINDOW}\n`);
	const result = await runCompactionE2E(chat);
	console.log(`  compaction events      ${result.compactionEvents}`);
	console.log(`  context after compact  ${result.contextAfterCompaction ?? "n/a"} estimated tokens (window ${result.window}, before ${result.contextBefore ?? "n/a"})`);
	console.log(`  summary has code/path  ${result.summaryMentionsCode} / ${result.summaryMentionsPath}`);
	console.log(`  summary excerpt        ${result.summary.replace(/\s+/g, " ").slice(0, 220)}`);
	console.log(`  recall answer          ${result.recallAnswer.slice(0, 160)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
