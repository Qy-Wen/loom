import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { commandAllowKey, DEFAULT_AGENT_PERMISSION, type AgentPermissionLevel, type CommandAllow, type ToolGateDecision } from "./tool-permission.ts";
import { workspaceWriteNeedsApproval } from "./workspace-path.ts";

export type PendingToolApproval = { toolCallId: string; toolName: string; args: Record<string, JsonValue> };
export type ToolApprovalDecision = "approve" | "reject" | "abort";
export interface ToolApprovalObserver {
	pending(call: PendingToolApproval): Promise<void>;
	settled(call: PendingToolApproval): Promise<void>;
}

/** Approval policy and cancellable waits, independent of conversations and transport. */
export class ToolApprovals {
	level: AgentPermissionLevel = DEFAULT_AGENT_PERMISSION;
	allows: readonly CommandAllow[] = [];
	readonly #waiting = new Map<string, { call: PendingToolApproval; resolve: (decision: ToolApprovalDecision) => void }>();

	needsApproval(root: string, name: string, args: unknown): boolean {
		return workspaceWriteNeedsApproval(this.level, name, root, args, this.allows);
	}

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

	/** External execution adapters can use this directly as their authorization callback. */
	async authorize(root: string, call: PendingToolApproval, observer: ToolApprovalObserver, signal?: AbortSignal): Promise<void> {
		const decision = await this.request(root, call, observer, signal);
		signal?.throwIfAborted();
		if (decision === "approve") return;
		if (decision === "reject") throw new Error("The user skipped this tool.");
		throw signal?.reason ?? new DOMException("The user pressed Stop.", "AbortError");
	}

	async request(root: string, call: PendingToolApproval, observer: ToolApprovalObserver, signal?: AbortSignal): Promise<ToolApprovalDecision> {
		signal?.throwIfAborted();
		if (!this.needsApproval(root, call.toolName, call.args)) return "approve";
		if (this.#waiting.has(call.toolCallId)) throw new Error("Duplicate tool approval identity");
		const snapshot = { ...call, args: copyJson(call.args) } as PendingToolApproval;
		const decision = Promise.withResolvers<ToolApprovalDecision>();
		this.#waiting.set(call.toolCallId, { call: snapshot, resolve: decision.resolve });
		const abort = () => decision.resolve("abort");
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await observer.pending(snapshot);
			if (signal?.aborted) abort();
			return await decision.promise;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#waiting.delete(call.toolCallId);
			await observer.settled(snapshot);
		}
	}
}
