/**
 * Threshold-compaction eval against a real Chat endpoint.
 *
 *   pnpm --filter @loom/agent eval:compaction-e2e
 *
 * Drives a real model with a deliberately small contextWindow so threshold
 * compaction fires mid-conversation, then checks:
 *   1. a compaction entry lands in the session
 *   2. the recorded context usage drops after compaction
 *   3. the summary keeps anchor facts the later turns can still recall
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HarnessSessionManager, type LoomAgentEvent } from "../src/index.ts";

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

function summaryText(messages: { role: string; summary?: unknown }[]): string {
	return messages
		.filter((message) => message.role === "compactionSummary")
		.map((message) => (typeof message.summary === "string" ? message.summary : ""))
		.join("\n");
}

export async function runCompactionE2E(
	chat: { baseUrl: string; apiKey?: string; model: string },
	options: { window?: number; turns?: number } = {},
): Promise<CompactionE2EResult> {
	const window = options.window ?? CONTEXT_WINDOW;
	const turns = options.turns ?? 4;
	const library = await mkdtemp(join(tmpdir(), "loom-compaction-e2e-"));
	const manager = new HarnessSessionManager({
		systemPrompt: "You are Loom. Answer briefly in one sentence. Do not call tools.",
		chat: { ...chat, contextWindow: window },
	});
	const events: LoomAgentEvent[] = [];
	try {
		await manager.openLibrary(library);
		const session = await manager.createSession();
		let lastContext: number | null = null;
		let contextAfterCompaction: number | null = null;

		for (let turn = 0; turn < turns; turn++) {
			const anchor = turn === 0
				? ` Remember for the whole session: the project code is ${ANCHOR.code}, the main file is ${ANCHOR.path}, and the theme color is ${ANCHOR.color}.`
				: "";
			await manager.prompt(session.id, `${filler(turn)}${anchor}`, {
				onEvent: (event) => events.push(event),
			});
			const record = await manager.getSession(session.id);
			const usage = record.context?.tokens ?? null;
			const compacted = events.some((event) => event.type === "compaction_end" && event.status === "completed");
			// First concrete reading after a compaction reflects the compacted context.
			if (compacted && contextAfterCompaction === null && usage !== null && usage < (lastContext ?? Infinity)) {
				contextAfterCompaction = usage;
			}
			if (usage !== null) lastContext = usage;
		}

		// Recall probe: can the model still name the anchors after compaction?
		await manager.prompt(session.id, `One line: what is the project code, main file, and theme color?`);
		const final = await manager.getSession(session.id);
		const recallAnswer = final.messages
			.filter((message) => message.role === "assistant")
			.map((message) => String(Array.isArray(message.content)
				? message.content.filter((part): part is { type: string; text: string } => typeof part === "object" && part.type === "text").map((part) => part.text).join(" ")
				: message.content ?? ""))
			.at(-1) ?? "";

		const summary = summaryText(final.messages);
		return {
			window,
			compactionEvents: events.filter((event) => event.type === "compaction_end" && event.status === "completed").length,
			contextBefore: contextAfterCompaction === null ? lastContext : (lastContext ?? null),
			contextAfterCompaction,
			summary,
			summaryMentionsCode: summary.includes(ANCHOR.code),
			summaryMentionsPath: summary.includes(ANCHOR.path),
			recallAnswer,
			turns,
		};
	} finally {
		await manager.close();
		await rm(library, { recursive: true, force: true });
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
	console.log(`  context after compact  ${result.contextAfterCompaction ?? "n/a"} tokens (window ${result.window}, final ${result.contextBefore ?? "n/a"})`);
	console.log(`  summary has code/path  ${result.summaryMentionsCode} / ${result.summaryMentionsPath}`);
	console.log(`  summary excerpt        ${result.summary.replace(/\s+/g, " ").slice(0, 220)}`);
	console.log(`  recall answer          ${result.recallAnswer.slice(0, 160)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
