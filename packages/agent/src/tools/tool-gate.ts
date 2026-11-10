import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	defineDoc, defineExtension, hook, ToolTask,
	type ConversationId, type Harness, type JsonObject,
} from "../durable-adapter.ts";
import { commandAllowKey, DEFAULT_AGENT_PERMISSION, type AgentPermissionLevel, type CommandAllow, type ToolGateDecision } from "./tool-permission.ts";
import { workspaceWriteNeedsApproval } from "./workspace-path.ts";

export const toolEventId = (conversationId: ConversationId, callId: string): string => `${conversationId}/${callId}`;
export type PendingToolApproval = { toolCallId: string; toolName: string; args: JsonObject };
export const LoomApprovalsDoc = defineDoc<{ pending: PendingToolApproval[] }>({
	kind: "loom.approvals", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ pending: [] }),
	checkpointWhen: () => true,
});

/** Approval policy is Loom-owned; the actual wait executes inside durable's cancellable ToolTask hook. */
export class ToolGate {
	level: AgentPermissionLevel = DEFAULT_AGENT_PERMISSION;
	allows: readonly CommandAllow[] = [];
	readonly #waiting = new Map<string, { call: PendingToolApproval; resolve: (decision: "approve" | "reject" | "abort") => void }>();

	pendingCommandAllow(id: string, root: string): CommandAllow | undefined {
		const pending = this.#waiting.get(id);
		return pending ? commandAllowKey(pending.call.toolName, pending.call.args, root) : undefined;
	}
	resolve(id: string, decision: ToolGateDecision): boolean {
		const pending = this.#waiting.get(id);
		if (!pending) return false;
		pending.resolve(decision === "reject" ? "reject" : "approve");
		return true;
	}
	setLevel(level: AgentPermissionLevel): void {
		this.level = level;
		if (level === "full") for (const pending of this.#waiting.values()) pending.resolve("approve");
	}

	extension(root: string, harness: () => Harness) {
		return defineExtension({ name: "loom.permission", hooks: [hook(ToolTask, {
			beforeTool: async (call, api, context) => {
				if (!workspaceWriteNeedsApproval(this.level, call.name, root, call.arguments, this.allows)) return undefined;
				context.abortSignal?.throwIfAborted();
				const id = toolEventId(api.conversationId, call.id);
				if (this.#waiting.has(id)) return { block: "Duplicate tool approval identity" };
				const callView = { toolCallId: id, toolName: call.name, args: copyJson(call.arguments as JsonValue) as JsonObject };
				const decision = Promise.withResolvers<"approve" | "reject" | "abort">();
				this.#waiting.set(id, { call: callView, resolve: decision.resolve });
				const abort = () => decision.resolve("abort");
				context.abortSignal?.addEventListener("abort", abort, { once: true });
				return context.telemetry.startSpan({ name: "loom.approval", attributes: { "tool.name": call.name, "tool.call_id": call.id } }, async (span) => {
					try {
						await harness().commit(async (tx) => { (await tx.doc(LoomApprovalsDoc, api.conversationId)).pending.push(callView); }, context);
						if (context.abortSignal?.aborted) abort();
						const result = await decision.promise;
						span.setAttributes({ decision: result });
						return result === "approve" ? undefined : { block: result === "reject" ? "The user skipped this tool." : "The user pressed Stop." };
					} finally {
						context.abortSignal?.removeEventListener("abort", abort);
						this.#waiting.delete(id);
						// Close may seal the host before cleanup; stale waits are cleared on reopen.
						await harness().commit(async (tx) => {
							const doc = await tx.doc(LoomApprovalsDoc, api.conversationId);
							doc.pending = doc.pending.filter((row) => row.toolCallId !== id);
						}, BACKGROUND_CONTEXT).catch(() => {});
					}
				});
			},
		})] });
	}
}

export async function clearPendingApprovals(harness: Harness): Promise<void> {
	await harness.commit(async (tx) => {
		let cursor;
		do {
			const page = await tx.scanConversations({}, 256, cursor);
			for (const record of page.items) (await tx.doc(LoomApprovalsDoc, record.id)).pending = [];
			cursor = page.next;
		} while (cursor !== undefined);
	}, BACKGROUND_CONTEXT);
}
