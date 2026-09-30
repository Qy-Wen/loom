/**
 * Vendor boundary with `pi-adapter.ts`. Wraps pi's harness tools as Loom tools.
 * cwd follows the open library when Main calls `setCwd`; paths are otherwise unrestricted.
 */
import {
	BACKGROUND_CONTEXT,
	createBashTool,
	withAbortSignal,
	createEditTool,
	createReadTool,
	createWriteTool,
	type AgentHarnessTool,
	type AgentHarnessToolInvocation,
	type ExecutionToolContext,
} from "#vendor/pi-agent";
import { NodeExecutionEnv } from "../vendor-pi-agent/src/harness/env/nodejs.ts";
import type { LoomTool, LoomToolContentPart, LoomToolResult } from "./types.ts";

export interface WorkspaceTools {
	tools: LoomTool[];
	setCwd: (cwd: string) => void;
}

const STUB_INVOCATION: AgentHarnessToolInvocation = {
	invocationId: "loom",
	operationId: "loom",
	turnId: "loom",
	getMemo: async () => undefined,
	setMemo: async () => undefined,
};

export function createWorkspaceTools(cwd = process.cwd()): WorkspaceTools {
	const env = new NodeExecutionEnv({ cwd });
	return {
		tools: [
			wrapHarnessTool(createReadTool(), env),
			wrapHarnessTool(createBashTool(), env),
			wrapHarnessTool(createEditTool(), env),
			wrapHarnessTool(createWriteTool(), env),
		],
		setCwd(next) {
			env.cwd = next;
		},
	};
}

function wrapHarnessTool(
	tool: AgentHarnessTool<ExecutionToolContext>,
	env: NodeExecutionEnv,
): LoomTool {
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		execute: async (args, signal) => {
			const result = await tool.execute(
				"loom",
				args as never,
				() => undefined,
				{ env },
				STUB_INVOCATION,
				signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT,
			);
			return {
				content: fromPiContent(result.content),
				details: result.details,
			} satisfies LoomToolResult;
		},
	};
}

function fromPiContent(content: unknown): LoomToolContentPart[] {
	if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];
	const parts: LoomToolContentPart[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const item = part as { type?: string; text?: string; data?: string; mimeType?: string };
		if (item.type === "image" && typeof item.data === "string") {
			parts.push({ type: "image", data: item.data, mimeType: item.mimeType ?? "image/png" });
		} else if (item.type === "text") {
			parts.push({ type: "text", text: item.text ?? "" });
		}
	}
	return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}
