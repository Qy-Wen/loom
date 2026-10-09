import { randomUUID } from "node:crypto";
import {
	AgentHarness,
	BACKGROUND_CONTEXT,
	DEFAULT_COMPACTION_SETTINGS,
	type Context,
	MemorySessionRepo,
	type AgentHarnessTool,
	type ExecutionToolContext,
} from "#vendor/pi-agent";
import { NodeExecutionEnv } from "#vendor/pi-agent/node";
import { Type } from "@earendil-works/pi-ai";
import { userTextFromContent } from "./attachments.ts";
import { buildChatModels, toProviderMessages } from "./pi-adapter.ts";
import type { LoomAgentEvent, LoomChatEndpoint, LoomTool } from "./types.ts";

const CONTEXT = BACKGROUND_CONTEXT;

export const RETRIEVE_AGENT_TOOL = "run_retrieve_agent";
export const CREATE_AGENT_TOOL = "run_create_agent";

const RETRIEVE_LIBRARY_TOOLS = new Set(["search_assets", "inspect_asset"]);

export type SpecialistRole = "retrieve" | "create";

export const RETRIEVE_SYSTEM_PROMPT =
	"You search and inspect the open asset library. Use search_assets and inspect_asset. Use read only for a file you already identified. " +
	"Do not create, edit, or delete files, and do not call generation tools. " +
	"When you name a library file, write an <asset_ref> block with path, asset_id, and type on their own lines, in that order, copied from the tool result. Omit asset_id when the result has none. Do not invent paths or ids. " +
	"Reply with those blocks and the passages that answer the task.";

export const CREATE_SYSTEM_PROMPT =
	"You generate assets from the task. Use the MCP tools. Use write or bash only to place results inside the library. " +
	"Do not search the library. Reply with the workspace-relative paths you wrote.";

export function isMcpToolName(name: string): boolean {
	return name.includes("__");
}

/** Split application tools into the parent chat, the retrieve specialist, and the create specialist. */
export function partitionLibraryTools(tools: readonly LoomTool[]): {
	parent: LoomTool[];
	retrieve: LoomTool[];
	create: LoomTool[];
} {
	const parent: LoomTool[] = [];
	const retrieve: LoomTool[] = [];
	const create: LoomTool[] = [];
	for (const tool of tools) {
		if (tool.name === RETRIEVE_AGENT_TOOL || tool.name === CREATE_AGENT_TOOL) continue;
		if (RETRIEVE_LIBRARY_TOOLS.has(tool.name)) retrieve.push(tool);
		else if (isMcpToolName(tool.name)) create.push(tool);
		else parent.push(tool);
	}
	return { parent, retrieve, create };
}

export function specialistUserMessage(goal: string): string {
	return `Task:\n${goal.trim()}`;
}

export function parseSpecialistArgs(args: unknown): { goal: string } {
	const record = typeof args === "object" && args !== null ? args as { goal?: unknown } : {};
	if (typeof record.goal !== "string" || record.goal.trim().length === 0) throw new TypeError("goal is required");
	return { goal: record.goal.trim() };
}

export function specialistParameters() {
	return Type.Object({
		goal: Type.String({ minLength: 1, description: "Self-contained task. The specialist cannot see the chat. Include asset ids in the text when the task needs them." }),
	});
}

export function specialistDescription(role: SpecialistRole): string {
	if (role === "retrieve") {
		return "Search and inspect the open library in a fresh context. Pass the full question in goal, including asset ids when the task needs them. Returns asset ids and passages. Independent calls in the same turn run together.";
	}
	return "Generate assets with MCP tools in a fresh context. Pass a self-contained brief in goal, including source asset ids when the task needs them. Does not search the library. Returns library paths written. Independent calls in the same turn run together.";
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

type BeforeTool = (
	event: { toolCallId: string; toolName: string; args: Record<string, unknown> },
	context: { abortSignal?: AbortSignal },
) => Promise<{ block?: { reason: string } } | undefined>;

/** One short-lived specialist. Its transcript stays in memory and is not a chat session. */
export async function runSpecialistAgent(options: {
	role: SpecialistRole;
	goal: string;
	cwd: string;
	chat: LoomChatEndpoint;
	tools: AgentHarnessTool<ExecutionToolContext>[];
	abortSignal?: AbortSignal;
	/** Parent run context, so this specialist's spans nest in the same trace. */
	context?: Context;
	onTool: (event: LoomAgentEvent) => void;
	onUsage?: (usage: Usage) => void;
	beforeTool: BeforeTool;
	registerAbort?: (abort: () => Promise<void>) => void;
}): Promise<string> {
	if (options.abortSignal?.aborted) throw new Error("The user pressed Stop. This turn was cancelled on purpose, not because of an error.");
	const traced = options.context ?? CONTEXT;
	const { models, model } = buildChatModels(options.chat);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, CONTEXT);
	let harness: AgentHarness<ExecutionToolContext> | undefined;
	const unsubscribers: Array<() => void> = [];
	try {
		const created = await AgentHarness.create({
			session,
			models,
			model,
			tools: options.tools,
			toolContext: { env: new NodeExecutionEnv({ cwd: options.cwd }) },
			systemPrompt: options.role === "retrieve" ? RETRIEVE_SYSTEM_PROMPT : CREATE_SYSTEM_PROMPT,
			toProviderMessages,
			compaction: DEFAULT_COMPACTION_SETTINGS,
			followUpMode: "one-at-a-time",
		}, traced);
		harness = created.harness;
		const lane = await harness.lane("main", traced);
		options.registerAbort?.(async () => {
			const stopped = await lane.abort(CONTEXT);
			if (!stopped.ok && stopped.error._tag !== "NoActiveOperation") throw stopped.error;
		});
		harness.hooks.on("before_tool", (event, hookContext) => options.beforeTool(event, hookContext), { id: "loom.specialist_permission" });
		unsubscribers.push(harness.events.on("tool_start", (event) => {
			options.onTool({ type: "tool_start", toolCallId: event.toolCallId, name: event.toolName, args: event.args });
		}));
		unsubscribers.push(harness.events.on("tool_end", (event) => {
			const content = event.result.content;
			const text = Array.isArray(content)
				? content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
				: String(content ?? "");
			options.onTool({
				type: "tool_end",
				toolCallId: event.toolCallId,
				name: event.toolName,
				result: { content: text, details: event.result.details },
				isError: event.isError,
			});
		}));
		unsubscribers.push(harness.events.on("usage", (event) => {
			if (event.row.adjustment) return;
			const usage = event.row.usage;
			options.onUsage?.({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
		}));
		const onAbort = () => {
			void lane.abort(CONTEXT);
		};
		options.abortSignal?.addEventListener("abort", onAbort);
		let summary = "";
		unsubscribers.push(harness.events.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			const text = userTextFromContent(event.message.content).trim();
			if (text) summary = text;
		}));
		try {
			const operationId = randomUUID();
			const accepted = await lane.accept({
				kind: "prompt",
				operationId,
				prompt: { role: "user", content: specialistUserMessage(options.goal), timestamp: Date.now() },
			}, traced);
			if (!accepted.ok) throw accepted.error;
			const outcome = await lane.drive({ operationId, waitForRetry: true }, traced);
			if (!outcome.ok) throw outcome.error;
			if (outcome.value.kind === "waiting") throw new Error(`Specialist is waiting for unsupported ${outcome.value.reason}`);
			if (outcome.value.outcome.status === "failed") {
				throw new Error(outcome.value.outcome.error?.message ?? "Specialist request failed");
			}
			if (options.abortSignal?.aborted) throw new Error("The user pressed Stop. This turn was cancelled on purpose, not because of an error.");
			return summary || "The specialist finished without a summary.";
		} finally {
			options.abortSignal?.removeEventListener("abort", onAbort);
		}
	} finally {
		for (const unsubscribe of unsubscribers) unsubscribe();
		await harness?.close(CONTEXT);
		await repo.close(CONTEXT);
	}
}
