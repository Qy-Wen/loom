import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BACKGROUND_CONTEXT as context, buildChatModels, createLibraryExtension, createSpecialistExtension,
	createWorkspaceTools, partitionLibraryTools, toDurableTool, LibraryAgent,
	type LibraryAgentOptions, type LoomChatEndpoint,
} from "../src/durable.ts";
import type { LoomTool } from "../src/types.ts";

/** Eval fixture only: native handles, no compatibility manager or custom drive/recovery. */
export async function openEvalAgent(chat: LoomChatEndpoint, options: { systemPrompt?: string; tools?: LoomTool[]; settings?: LibraryAgentOptions["settings"] } = {}) {
	const library = await mkdtemp(join(tmpdir(), "loom-eval-"));
	try {
		const built = buildChatModels(chat);
		const grouped = partitionLibraryTools(options.tools ?? []);
		const workspace = await createWorkspaceTools({ images: false });
		const permission = { name: "eval.permission" };
		const retrieve = createSpecialistExtension("retrieve", [...workspace.filter((tool) => tool.name === "read"), ...grouped.retrieve.map(toDurableTool)], permission);
		const create = createSpecialistExtension("create", grouped.create.map(toDurableTool), permission);
		const assembly = await createLibraryExtension(library, { systemPrompt: options.systemPrompt, tools: grouped.parent, autoMemory: false, skills: false, workspace: { images: false } });
		const extension = { ...assembly.extension, tools: [...assembly.extension.tools!, retrieve.tool, create.tool] };
		const owner = await LibraryAgent.open(library, {
			models: built.models, extensions: [extension, retrieve.child, create.child, permission],
			settings: { ...options.settings, extensions: [extension] },
			agent: { model: { provider: built.model.provider, modelId: built.model.id } },
		}, context);
		return { owner, library, async close() { try { await owner.close(context); } finally { await rm(library, { recursive: true, force: true }); } } };
	} catch (error) { await rm(library, { recursive: true, force: true }); throw error; }
}
export { context };
