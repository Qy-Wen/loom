/** Native Pi harness tools. cwd follows the open library; paths are otherwise unrestricted. */
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type AgentHarnessTool,
	type ExecutionToolContext,
} from "#vendor/pi-agent";
import { NodeExecutionEnv } from "#vendor/pi-agent/node";
import { Type } from "@earendil-works/pi-ai";
import { processReadImage } from "./read-image.ts";
import type { LoomTool, LoomToolContentPart, LoomToolResult } from "./types.ts";

export interface WorkspaceTools {
	tools: AgentHarnessTool<ExecutionToolContext>[];
	toolContext: ExecutionToolContext;
	setCwd: (cwd: string) => void;
}

export function createWorkspaceTools(cwd = process.cwd()): WorkspaceTools {
	const toolContext = { env: new NodeExecutionEnv({ cwd }) };
	return {
		tools: [createReadTool({ imageProcessor: processReadImage }), createBashTool(), createEditTool(), createWriteTool()],
		toolContext,
		setCwd(next) {
			toolContext.env.cwd = next;
		},
	};
}

/** Adapt an application tool without allowing unknown side effects to replay after recovery. */
export function toHarnessTool(tool: LoomTool): AgentHarnessTool<ExecutionToolContext> {
	return {
		name: tool.name,
		label: tool.name,
		description: tool.description,
		parameters: (tool.parameters ?? Type.Object({})) as AgentHarnessTool<ExecutionToolContext>["parameters"],
		replay: "never",
		async execute(_toolCallId, args, _onUpdate, _toolContext, _invocation, context) {
			context.abortSignal?.throwIfAborted();
			const output = await tool.execute(args, context.abortSignal);
			const result: LoomToolResult = typeof output === "string" ? { content: output } : output;
			return {
				content: toPiContent(result.content),
				details: result.details,
			};
		},
	};
}

function toPiContent(content: string | LoomToolContentPart[]): LoomToolContentPart[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}
