/**
 * Prompt-cache hit rate from Chat usage: cacheRead / prompt_tokens.
 *
 *   pnpm --filter @loom/agent eval:prompt-cache-hit
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HarnessSessionManager, uiSelectionToAttach, type LoomTranscriptMessage, type UiSelectionFields } from "../src/index.ts";

export type UsageSnapshot = {
	/** Uncached prompt tokens (`prompt_tokens - cacheRead - cacheWrite` in pi-ai). */
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
};

export type CacheHit = {
	hit: number;
	promptTokens: number;
	cacheRead: number;
	input: number;
	cacheWrite: number;
};

function numberField(row: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function usageFromMessage(message: Record<string, unknown> | undefined): UsageSnapshot | undefined {
	if (!message || message.role !== "assistant") return undefined;
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const row = usage as Record<string, unknown>;
	const input = numberField(row, ["input"]);
	if (input === undefined) return undefined;
	return {
		input,
		cacheRead: numberField(row, ["cacheRead"]) ?? 0,
		cacheWrite: numberField(row, ["cacheWrite"]) ?? 0,
		output: numberField(row, ["output"]) ?? 0,
	};
}

/** Authoritative hit rate: cacheRead / (input + cacheRead + cacheWrite). */
export function cacheHitFromUsage(usage: UsageSnapshot): CacheHit {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		hit: promptTokens === 0 ? 0 : usage.cacheRead / promptTokens,
		promptTokens,
		cacheRead: usage.cacheRead,
		input: usage.input,
		cacheWrite: usage.cacheWrite,
	};
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const CLIP: UiSelectionFields = { assetId: "asset-clip", path: "clips/hero.mp4", assetType: "video" };
const NOTE: UiSelectionFields = { assetId: "asset-note", path: "notes/brief.md", assetType: "text" };

/** Stable prefix target in tokens. DeepSeek-V4.1-Flash context is 1M. */
export const CACHE_PAD_TOKENS = 150_000;

/**
 * Last 150197-char pad landed at ~26427 prompt_tokens (~5.7 chars/token on this English unit).
 * 6 chars/token keeps the system prefix above 150k tokens.
 */
export const CHARS_PER_TOKEN = 6;
export const CACHE_PAD_CHARS = CACHE_PAD_TOKENS * CHARS_PER_TOKEN;

let cachedPaddedSystemPrompt: string | undefined;

export function paddedSystemPrompt(): string {
	if (cachedPaddedSystemPrompt) return cachedPaddedSystemPrompt;
	const unit = "The working directory is a local creative asset library. ";
	const pad = unit.repeat(Math.ceil(CACHE_PAD_CHARS / unit.length));
	cachedPaddedSystemPrompt =
		`${pad}\n` +
		"You are Loom. Reply with one short sentence. Do not call tools. " +
		"A user message may include <asset_ref> blocks for library files placed in the message, and a <ui_selection> block for the file selected in the library when they sent it.";
	return cachedPaddedSystemPrompt;
}

export type PromptCacheTurn = {
	user: string;
	selection?: UiSelectionFields | null;
};

export type PromptCacheHitResult = {
	name: string;
	usages: UsageSnapshot[];
	hits: CacheHit[];
	meanHit: number;
};

function lastAssistantUsage(messages: LoomTranscriptMessage[]): UsageSnapshot | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = usageFromMessage(messages[i]);
		if (usage) return usage;
	}
	return undefined;
}

export async function runPromptCacheHit(
	name: string,
	turns: PromptCacheTurn[],
	chat: { baseUrl: string; apiKey?: string; model: string },
): Promise<PromptCacheHitResult> {
	const library = await mkdtemp(join(tmpdir(), "loom-prompt-cache-"));
	const manager = new HarnessSessionManager({ systemPrompt: paddedSystemPrompt(), chat });
	manager.setPermissionLevel("full");
	try {
		await manager.openLibrary(library);
		const session = await manager.createSession();
		const usages: UsageSnapshot[] = [];
		const hits: CacheHit[] = [];

		for (const turn of turns) {
			const before = await manager.getSession(session.id);
			const attachment = uiSelectionToAttach(turn.selection ?? null, before.messages);
			await manager.prompt(session.id, turn.user, attachment ? { attachments: [attachment] } : undefined);
			const after = await manager.getSession(session.id);
			const usage = lastAssistantUsage(after.messages);
			if (!usage) throw new Error(`No usage on assistant message after: ${turn.user}`);
			hits.push(cacheHitFromUsage(usage));
			usages.push(usage);
		}

		return {
			name,
			usages,
			hits,
			meanHit: mean(hits.map((row) => row.hit)),
		};
	} finally {
		await manager.close();
		await rm(library, { recursive: true, force: true });
	}
}

export function sameSelectionTurns(): PromptCacheTurn[] {
	return [
		{ user: "把这个处理一下。只回一句。", selection: CLIP },
		{ user: "再裁短一点。只回一句。", selection: CLIP },
		{ user: "导出一帧。只回一句。", selection: CLIP },
	];
}

export function changedSelectionTurns(): PromptCacheTurn[] {
	return [
		{ user: "把这个处理一下。只回一句。", selection: CLIP },
		{ user: "这篇也看下。只回一句。", selection: NOTE },
		{ user: "总结一下。只回一句。", selection: NOTE },
	];
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

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
	const chat = chatFromEnv();
	if (!chat) {
		throw new Error("DEEPSEEK_API_KEY is required for prompt-cache hit rate.");
	}

	console.log("Prompt-cache hit rate  (API usage: cacheRead / prompt_tokens)\n");
	console.log(`  ${chat.baseUrl}  ${chat.model}`);
	console.log(`  system pad  ${paddedSystemPrompt().length} chars  (target ${CACHE_PAD_TOKENS} tokens)`);
	console.log("  prompt_tokens = input + cacheRead + cacheWrite  (pi-ai split of the Chat usage object)\n");

	for (const [name, turns] of [
		["same-selection", sameSelectionTurns()],
		["changed-selection", changedSelectionTurns()],
	] as const) {
		const result = await runPromptCacheHit(name, turns, chat);
		console.log(`${result.name}`);
		console.log(`  mean hit  ${pct(result.meanHit)}`);
		for (const [index, hit] of result.hits.entries()) {
			console.log(
				`  turn ${index + 1}  hit=${pct(hit.hit)}  ` +
					`prompt=${hit.promptTokens}  cacheRead=${hit.cacheRead}  ` +
					`input=${hit.input}  cacheWrite=${hit.cacheWrite}`,
			);
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
