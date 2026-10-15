/** Durable coding tools. Each call gets its cwd/environment from HarnessOptions.env. */
import { prepareSandboxedBash } from "@loom/core/sandbox";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { copyJson, type JsonValue } from "@earendil-works/chord";
import {
	createBashTool,
	createEditTool,
	createNodePhotonImages,
	createReadTool,
	createWriteTool,
	defineTool,
	type BashPrepare,
	type ImageProcessor,
	type ToolRegistration,
} from "./durable-adapter.ts";
import type { LoomTool, LoomToolContentPart } from "./types.ts";

export type WorkspaceToolOptions = {
	/** Omitted: upstream Photon worker; false: only pass through supported, bounded images. */
	images?: ImageProcessor | false;
	/** Defaults to Loom's process sandbox. Used by hosts with their own sandbox implementation. */
	prepareBash?: BashPrepare;
};

export async function createWorkspaceTools(options: WorkspaceToolOptions = {}): Promise<ToolRegistration[]> {
	const images = options.images === false ? undefined : options.images ?? await createNodePhotonImages();
	return [
		createReadTool({ images }),
		createBashTool({ prepare: options.prepareBash ?? ((execution) => prepareSandboxedBash(execution)) }),
		createEditTool(),
		createWriteTool(),
	];
}

/** Adapt Loom results to durable's model output and committed UI details; external effects are not replay-safe. */
export function toDurableTool(tool: LoomTool): ToolRegistration {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: (tool.parameters ?? Type.Object({})) as TSchema,
		replay: "unsafe",
		async execute(args, _api, context) {
			context.abortSignal?.throwIfAborted();
			const output = await tool.execute(args, context.abortSignal);
			const result = typeof output === "string" ? { content: output } : output;
			const content: LoomToolContentPart[] = typeof result.content === "string"
				? [{ type: "text", text: result.content }]
				: result.content.map((part): LoomToolContentPart => {
					if (part.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
					if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
						return { type: "image", data: part.data, mimeType: part.mimeType };
					}
					return { type: "text", text: JSON.stringify(part) };
				});
			// Match JSON object semantics for optional fields; still reject non-JSON values (Date, etc.).
			return {
				output: content,
				...(result.details === undefined ? {} : { details: copyJson(result.details as JsonValue, { omitUndefinedProperties: true }) }),
			};
		},
	});
}
