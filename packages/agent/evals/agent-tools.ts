/**
 * Agent / tool-call eval against the in-repo gold tasks.
 *
 *   pnpm --filter @loom/agent eval:agent-tools
 *   pnpm --filter @loom/agent eval:agent-tools:live
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { EVAL_FILES } from "../../core/evals/library.ts";
import { contentWithPlacedAssets, implicitSelectionAttachments, type AssetRefAttachment } from "../src/attachments.ts";
import { HarnessSessionManager } from "../src/harness-session-manager.ts";
import type { LoomAgentEvent, LoomTool } from "../src/types.ts";
import { answerFromEvents, callsFromEvents, scoreAgentTask, type AgentScore } from "./agent-score.ts";
import { chatFromEnv } from "./compaction-e2e.ts";
import { AGENT_EVAL_TASKS, type AgentEvalTask } from "./tasks.ts";

export type AgentEvalResult = {
	scores: AgentScore[];
	passed: number;
	failed: number;
};

const AGENT_EVAL_SYSTEM_PROMPT =
	"You are Loom, an assistant for a local creative asset workspace. " +
	"The working directory is the asset library the user has open. " +
	"Use run_retrieve_agent to search or inspect the library. Pass the full question in goal, including asset ids when the task needs them. It returns <asset_ref> blocks and passages. You do not have search_assets or inspect_asset. " +
	"A user message may include <asset_ref> blocks for library files the user placed in the text. " +
	"A <system-reminder> after those words is context the app attached, not text they typed. It may contain a <ui_selection> for the file selected in the library. That selection may or may not be related to the task. " +
	"Use those blocks when they say this/the file without naming one. If they name a different path, prefer that. " +
	"When your reply names a library file, write an <asset_ref> block with path, asset_id, and type on their own lines, in that order. Copy path and asset_id from the tool result or from a user <asset_ref>. Omit asset_id when you do not have one. Do not invent paths or ids. " +
	"Do not use bash, write, or edit for looking up or inspecting a library file that is already identified.";

const MOCK_TOOLS: LoomTool[] = [
	{
		name: "search_assets",
		description: "Search the open local asset library.",
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
		execute: (args) => JSON.stringify({ total: 1, query: (args as { query?: string }).query, assets: [{ path: "notes/river.md" }] }),
	},
	{
		name: "inspect_asset",
		description: "Inspect one asset by stable assetId.",
		parameters: Type.Object({ assetId: Type.String({ minLength: 1 }) }),
		execute: (args) => JSON.stringify({ assetId: (args as { assetId: string }).assetId, path: "notes/river.md" }),
	},
];

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

async function stop(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
			return "";
		})
		.join("\n");
}

function lastUserText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object") continue;
		const row = message as { role?: string; content?: unknown };
		if (row.role === "user") return contentText(row.content);
	}
	return "";
}

function hasToolResult(messages: unknown[]): boolean {
	return messages.some((message) => {
		if (!message || typeof message !== "object") return false;
		const role = (message as { role?: string }).role;
		return role === "tool" || role === "toolResult" || role === "function";
	});
}

function writeSse(response: import("node:http").ServerResponse, payload: unknown): void {
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishText(response: import("node:http").ServerResponse, text: string): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	writeSse(response, {
		id: "eval-text",
		object: "chat.completion.chunk",
		created: 0,
		model: "eval",
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
	});
	writeSse(response, {
		id: "eval-text",
		object: "chat.completion.chunk",
		created: 0,
		model: "eval",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	});
	response.end("data: [DONE]\n\n");
}

function finishTool(response: import("node:http").ServerResponse, name: string, args: Record<string, unknown>): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	writeSse(response, {
		id: "eval-tool",
		object: "chat.completion.chunk",
		created: 0,
		model: "eval",
		choices: [{
			index: 0,
			delta: {
				role: "assistant",
				tool_calls: [{
					index: 0,
					id: `eval-${name}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				}],
			},
			finish_reason: null,
		}],
	});
	writeSse(response, {
		id: "eval-tool",
		object: "chat.completion.chunk",
		created: 0,
		model: "eval",
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	});
	response.end("data: [DONE]\n\n");
}

function requestToolNames(body: string): string[] {
	try {
		const tools = (JSON.parse(body) as { tools?: unknown[] }).tools ?? [];
		return tools.flatMap((tool) => {
			if (!tool || typeof tool !== "object") return [];
			const row = tool as { name?: unknown; function?: { name?: unknown } };
			const name = typeof row.function?.name === "string" ? row.function.name : row.name;
			return typeof name === "string" ? [name] : [];
		});
	} catch {
		return [];
	}
}

function stubReply(messages: unknown[], names: readonly string[], response: import("node:http").ServerResponse): void {
	if (hasToolResult(messages)) {
		const user = lastUserText(messages);
		finishText(response, /2\s*\+\s*2/.test(user) ? "4" : "Done.");
		return;
	}
	const user = lastUserText(messages);
	if (names.includes("run_retrieve_agent")) {
		const selected = user.match(/asset_id:\s*(\S+)/i);
		if (selected) {
			finishTool(response, "run_retrieve_agent", { goal: user });
			return;
		}
		if (/find|search|bicycle|dock|river|bike/i.test(user)) {
			finishTool(response, "run_retrieve_agent", { goal: user });
			return;
		}
		finishText(response, /2\s*\+\s*2/.test(user) ? "4" : "Ok.");
		return;
	}
	const selected = user.match(/asset_id:\s*(\S+)/i);
	if (names.includes("inspect_asset") && selected) {
		finishTool(response, "inspect_asset", { assetId: selected[1]!.replace(/[>"']+$/, "") });
		return;
	}
	if (names.includes("search_assets") && /find|search|bicycle|dock|river|bike/i.test(user)) {
		finishTool(response, "search_assets", { query: user });
		return;
	}
	finishText(response, /2\s*\+\s*2/.test(user) ? "4" : "Ok.");
}

export function startStubChat(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			let messages: unknown[] = [];
			try {
				messages = (JSON.parse(body) as { messages?: unknown[] }).messages ?? [];
			} catch {
				messages = [];
			}
			stubReply(messages, requestToolNames(body), response);
		});
	});
	return listen(server).then((baseUrl) => ({
		baseUrl,
		close: () => stop(server),
	}));
}

async function runTask(
	manager: HarnessSessionManager,
	task: AgentEvalTask,
): Promise<AgentScore> {
	const session = await manager.createSession();
	const events: LoomAgentEvent[] = [];
	const before = await manager.getSession(session.id);
	const chips: AssetRefAttachment[] = (task.chips ?? []).map((chip) => ({ type: "asset_ref", ...chip }));
	const attachments = implicitSelectionAttachments(chips, task.selection ?? null, before.messages);
	await manager.prompt(session.id, contentWithPlacedAssets(task.user, chips), {
		attachments: attachments.length > 0 ? attachments : undefined,
		onEvent: (event) => events.push(event),
	});
	return scoreAgentTask(task, callsFromEvents(events), answerFromEvents(events));
}

async function writeEvalLibrary(root: string): Promise<void> {
	for (const file of EVAL_FILES) {
		const path = join(root, file.relativePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, file.text);
	}
}

export async function runAgentToolsEval(chat: { baseUrl: string; apiKey?: string; model: string }): Promise<AgentEvalResult> {
	const library = await mkdtemp(join(tmpdir(), "loom-agent-eval-"));
	await writeEvalLibrary(library);
	const manager = new HarnessSessionManager({
		systemPrompt: AGENT_EVAL_SYSTEM_PROMPT,
		chat: { ...chat, model: chat.model || "eval" },
		tools: MOCK_TOOLS,
	});
	manager.setPermissionLevel("full");
	try {
		await manager.openLibrary(library);
		const scores: AgentScore[] = [];
		for (const task of AGENT_EVAL_TASKS) scores.push(await runTask(manager, task));
		return {
			scores,
			passed: scores.filter((score) => score.ok).length,
			failed: scores.filter((score) => !score.ok).length,
		};
	} finally {
		await manager.close();
		await rm(library, { recursive: true, force: true });
	}
}

export async function runStubAgentToolsEval(): Promise<AgentEvalResult> {
	const stub = await startStubChat();
	try {
		return await runAgentToolsEval({ baseUrl: stub.baseUrl, apiKey: "eval", model: "eval" });
	} finally {
		await stub.close();
	}
}

function print(result: AgentEvalResult): void {
	console.log("Agent / tool-call eval\n");
	for (const score of result.scores) {
		const detail = [
			score.missingTools.length ? `missing ${score.missingTools.join(",")}` : "",
			score.forbiddenHits.length ? `forbid ${score.forbiddenHits.join(",")}` : "",
			score.argMisses.length ? `args ${score.argMisses.join(",")}` : "",
			score.answerMisses.length ? `answer ${score.answerMisses.join(",")}` : "",
		].filter(Boolean).join("; ");
		console.log(`  ${score.id.padEnd(22)} ${score.ok ? "pass" : "fail"}${detail ? `  ${detail}` : ""}`);
		if (!score.ok) {
			for (const call of score.calls) {
				console.log(`    ${call.name} ${JSON.stringify(call.args)}`);
			}
		}
	}
	console.log(`\n  passed ${result.passed}  failed ${result.failed}`);
}

async function main(): Promise<void> {
	const live = process.argv.includes("--live");
	if (live) {
		const chat = chatFromEnv();
		if (!chat) throw new Error("DEEPSEEK_API_KEY is required for the live agent eval.");
		console.log(`  ${chat.baseUrl}  ${chat.model}\n`);
		const result = await runAgentToolsEval(chat);
		print(result);
		if (result.failed > 0) process.exit(1);
		return;
	}
	const result = await runStubAgentToolsEval();
	print(result);
	if (result.failed > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
