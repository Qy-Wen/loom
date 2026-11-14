import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	defineDoc, defineExtension, hook, ToolTask,
	type ConversationId, type Harness, type JsonObject,
} from "../durable-adapter.ts";
import { ToolApprovals, type PendingToolApproval } from "./approvals.ts";

export type { PendingToolApproval } from "./approvals.ts";

export const toolEventId = (conversationId: ConversationId, callId: string): string => `${conversationId}/${callId}`;
export const LoomApprovalsDoc = defineDoc<{ pending: PendingToolApproval[] }>({
	kind: "loom.approvals", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ pending: [] }),
	checkpointWhen: () => true,
});

/** Approval policy is Loom-owned; the actual wait executes inside durable's cancellable ToolTask hook. */
export class ToolGate extends ToolApprovals {
	extension(root: string, harness: () => Harness) {
		return defineExtension({ name: "loom.permission", hooks: [hook(ToolTask, {
			beforeTool: async (call, api, context) => {
				if (!this.needsApproval(root, call.name, call.arguments)) return undefined;
				context.abortSignal?.throwIfAborted();
				const id = toolEventId(api.conversationId, call.id);
				const callView = { toolCallId: id, toolName: call.name, args: call.arguments as JsonObject };
				return context.telemetry.startSpan({ name: "loom.approval", attributes: { "tool.name": call.name, "tool.call_id": call.id } }, async (span) => {
					const result = await this.request(root, callView, {
						pending: (pending) => harness().commit(async (tx) => { (await tx.doc(LoomApprovalsDoc, api.conversationId)).pending.push(pending); }, context),
						settled: async () => {
							// Close may seal the host before cleanup; stale waits are cleared on reopen.
							await harness().commit(async (tx) => {
								const doc = await tx.doc(LoomApprovalsDoc, api.conversationId);
								doc.pending = doc.pending.filter((row) => row.toolCallId !== id);
							}, BACKGROUND_CONTEXT).catch(() => {});
						},
					}, context.abortSignal);
					span.setAttributes({ decision: result });
					return result === "approve" ? undefined : { block: result === "reject" ? "The user skipped this tool." : "The user pressed Stop." };
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
