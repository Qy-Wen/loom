import {
	defineDoc,
	defineExtension,
	section,
	type ConversationRecord,
	type Tx,
} from "../durable-adapter.ts";
import {
	createAutoMemoryTool,
	formatAutoMemoryForSystemPrompt,
	readLibraryAutoMemory,
} from "./library-auto-memory.ts";
import { createWorkspaceTools, toDurableTool, type WorkspaceToolOptions } from "../tools/pi-tools.ts";
import { formatSkillsForSystemPrompt, LIBRARY_SKILLS_DIR, loadLibrarySkills } from "./library-skills.ts";
import { markdownAuthoringSection } from "./markdown-authoring.ts";
import type { LoomTool } from "../types.ts";

function skillDirectories(userSkillsDir?: string): string {
	const home = userSkillsDir?.replaceAll("\\", "/").replace(/\/+$/, "");
	const library = `${LIBRARY_SKILLS_DIR}/ relative to the library root`;
	if (!home) return `Skills for this library are in ${library}.`;
	return `Skills for every library are in ${home}/. Skills for this library only are in ${library}. A library skill with the same name is used instead. When creating a skill, create it in ${home}/ by default.`;
}

/** Memory stays frozen per conversation. Forks retain the source snapshot, not the current file. */
export const LoomMemoryDoc = defineDoc<{ snapshot: string }>({
	kind: "loom.memory",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ snapshot: "" }),
	checkpointWhen: () => true,
});

export type LibraryExtensionOptions = {
	systemPrompt?: string;
	/** The chat's Loom tools. Specialist tool partitioning is installed separately. */
	tools?: readonly LoomTool[];
	workspace?: WorkspaceToolOptions;
	/** Default true; specialists should disable memory or not select this extension. */
	autoMemory?: boolean;
	/** Discover the library catalog on each request; bodies are loaded only through read. */
	skills?: boolean;
	/** Home skills directory, normally ~/.loom/skills. Applies to every library; a library skill with the same name wins. */
	userSkillsDir?: string;
};

/** Assemble tools and stable prompt sections; pass conversationCreated to LibraryRuntime.open(). */
export async function createLibraryExtension(root: string, options: LibraryExtensionOptions = {}) {
	const memory = options.autoMemory !== false;
	const workspace = await createWorkspaceTools(options.workspace);
	// Reject duplicate tool names instead of relying on install-order overrides inside one Loom bundle.
	const tools = [
		...workspace,
		...(options.tools ?? []).map(toDurableTool),
		...(memory ? [createAutoMemoryTool(root)] : []),
	];
	const names = new Set<string>();
	for (const tool of tools) {
		if (names.has(tool.name)) throw new Error(`Duplicate library tool: ${tool.name}`);
		names.add(tool.name);
	}
	const systemPrompt = options.systemPrompt?.trim();
	const extension = defineExtension({
		name: "loom.library",
		tools,
		sections: [
			section("preamble", () => systemPrompt || undefined, { tag: false }),
			...(options.skills !== false ? [section("skills", async (input, context) => {
				if (!input.env) return undefined;
				const { skills } = await loadLibrarySkills(input.env, root, context, options.userSkillsDir);
				const catalog = formatSkillsForSystemPrompt(skills);
				const guide = skillDirectories(options.userSkillsDir);
				return catalog ? `${guide}\n\n${catalog}` : guide;
			}, { tag: false })] : []),
			...(memory ? [section("auto_memory", async (input, context) => {
				const saved = await input.read.snapshot(LoomMemoryDoc, input.conversationId, context);
				return formatAutoMemoryForSystemPrompt(saved?.snapshot ?? "") || undefined;
			}, { tag: false })] : []),
			markdownAuthoringSection,
		],
	});
	return {
		extension,
		async conversationCreated(tx: Tx, conversation: ConversationRecord): Promise<void> {
			if (!memory) return;
			const document = await tx.doc(LoomMemoryDoc, conversation.id);
			if (conversation.parent === undefined) document.snapshot = await readLibraryAutoMemory(root);
		},
	};
}
