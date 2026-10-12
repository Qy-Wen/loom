import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, configure, defineExtension, defineTool, type Extension, type ToolRegistration } from "./durable-adapter.ts";
import { userTextFromContent } from "./attachments.ts";
import type { LoomTool } from "./types.ts";

export const RETRIEVE_AGENT_TOOL = "run_retrieve_agent";
export const CREATE_AGENT_TOOL = "run_create_agent";

const RETRIEVE_LIBRARY_TOOLS = new Set(["search_assets", "inspect_asset"]);

export type SpecialistRole = "retrieve" | "create";

export const RETRIEVE_SYSTEM_PROMPT =
	"You search and inspect the open asset library. Use search_assets and inspect_asset. Use read only for a file you already identified. " +
	"Do not create, edit, or delete files, and do not call generation tools. " +
	"When you name a library file, write an <asset_ref> block with path, asset_id, and type on their own lines, in that order, copied from the tool result. Omit asset_id when the result has none. Do not invent paths or ids. " +
	"If a search row has linkedFrom, it is a connected file: include its asset_ref and the relation type. " +
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

/** Foreground owned conversations: durable controls Stop, busy state, and restart ownership. */
export function createSpecialistExtension(role: SpecialistRole, tools: readonly ToolRegistration[], permission: Extension) {
	const child = defineExtension({ name: `loom.${role}`, tools });
	const tool = defineTool({
		name: role === "retrieve" ? RETRIEVE_AGENT_TOOL : CREATE_AGENT_TOOL,
		description: specialistDescription(role), parameters: specialistParameters(), replay: "safe",
		async execute(args, api, context) {
			const { goal } = parseSpecialistArgs(args);
			const childId = await api.commit(async (tx) => {
				const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
				if (existing) return existing.id;
				const record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await configure(tx, record.id, {
					extensions: [child, permission],
					instructions: role === "retrieve" ? RETRIEVE_SYSTEM_PROMPT : CREATE_SYSTEM_PROMPT,
				});
				return record.id;
			}, context);
			await api.details({ conversationId: childId }, context);
			const conversation = await api.conversation(childId, context);
			if (!conversation) throw new Error("Specialist conversation is missing");
			const submission = await conversation.submit({ type: "input", content: specialistUserMessage(goal), requestId: `specialist:${api.taskId}` }, context);
			const result = await submission.wait(context);
			if (result.status !== "done" || result.type !== "input") throw new Error(`Specialist failed: ${result.status}${result.status === "unanswered" ? ` (${result.reason})` : ""}`);
			const answer = await api.commit((tx) => tx.entry(AssistantEntry, result.answer), context);
			return { output: [{ type: "text", text: userTextFromContent(answer?.model?.[0]?.content) || "The specialist finished without a summary." }] };
		},
	});
	return { child, tool };
}
