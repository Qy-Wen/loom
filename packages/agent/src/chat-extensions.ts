import type { Extension } from "./durable-adapter.ts";
import { createLibraryExtension, type LibraryExtensionOptions } from "./library-extension.ts";
import { createWorkspaceTools, toDurableTool } from "./pi-tools.ts";
import { createSpecialistExtension, partitionLibraryTools } from "./specialist.ts";

/** Shared parent/specialist assembly for the app and headless evaluations. */
export async function createChatExtensions(
	root: string,
	options: LibraryExtensionOptions & { permission: Extension; sharedExtensions?: readonly Extension[] },
) {
	const grouped = partitionLibraryTools(options.tools ?? []);
	const workspace = await createWorkspaceTools(options.workspace);
	const sharedExtensions = options.sharedExtensions ?? [];
	const retrieve = createSpecialistExtension("retrieve", [...workspace.filter((tool) => tool.name === "read"), ...grouped.retrieve.map(toDurableTool)], options.permission, sharedExtensions);
	const create = createSpecialistExtension("create", [...workspace.filter((tool) => ["read", "edit", "write", "bash"].includes(tool.name)), ...grouped.create.map(toDurableTool)], options.permission, sharedExtensions);
	const assembly = await createLibraryExtension(root, { ...options, tools: grouped.parent });
	return {
		extension: { ...assembly.extension, tools: [...assembly.extension.tools!, retrieve.tool, create.tool] },
		specialists: [retrieve.child, create.child],
		conversationCreated: assembly.conversationCreated,
	};
}
