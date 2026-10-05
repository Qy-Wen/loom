export const AGENT_PERMISSION_LEVELS = ["basic", "standard", "full"] as const;

export type AgentPermissionLevel = (typeof AGENT_PERMISSION_LEVELS)[number];

/** Product default: confirm file writes. Evals that must not hang should set `full`. */
export const DEFAULT_AGENT_PERMISSION: AgentPermissionLevel = "standard";

export const AGENT_PERMISSION_OPTIONS = [
	{ value: "basic", label: "Basic permission" },
	{ value: "standard", label: "Standard permission" },
	{ value: "full", label: "Full permission" },
] as const satisfies ReadonlyArray<{ value: AgentPermissionLevel; label: string }>;

export type ToolGateDecision = "approve" | "reject";

const STANDARD_TOOLS = ["write", "edit"] as const;
const BASIC_TOOLS = ["write", "edit", "bash"] as const;

export function parseAgentPermissionLevel(value: unknown): AgentPermissionLevel {
	if (value === "basic" || value === "standard" || value === "full") return value;
	return DEFAULT_AGENT_PERMISSION;
}

export function gatedToolNames(level: AgentPermissionLevel): ReadonlySet<string> {
	if (level === "full") return new Set();
	if (level === "standard") return new Set(STANDARD_TOOLS);
	return new Set(BASIC_TOOLS);
}

export function toolNeedsApproval(level: AgentPermissionLevel, toolName: string): boolean {
	return gatedToolNames(level).has(toolName);
}

export class ToolApprovalQueue {
	private readonly pending = new Map<string, {
		sessionId: string;
		resolve: (decision: ToolGateDecision | "abort") => void;
	}>();

	wait(sessionId: string, toolCallId: string, signal?: AbortSignal): Promise<ToolGateDecision | "abort"> {
		if (signal?.aborted) return Promise.resolve("abort");
		return new Promise((resolve) => {
			const finish = (decision: ToolGateDecision | "abort") => {
				if (!this.pending.delete(toolCallId)) return;
				signal?.removeEventListener("abort", onAbort);
				resolve(decision);
			};
			const onAbort = () => finish("abort");
			this.pending.set(toolCallId, { sessionId, resolve: finish });
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	resolve(toolCallId: string, decision: ToolGateDecision): boolean {
		const row = this.pending.get(toolCallId);
		if (!row) return false;
		row.resolve(decision);
		return true;
	}

	abortSession(sessionId: string): void {
		for (const [toolCallId, row] of [...this.pending]) {
			if (row.sessionId === sessionId) row.resolve("abort");
		}
	}

	abortAll(): void {
		for (const row of [...this.pending.values()]) row.resolve("abort");
	}

	approveAll(): void {
		for (const row of [...this.pending.values()]) row.resolve("approve");
	}

	get size(): number {
		return this.pending.size;
	}
}
