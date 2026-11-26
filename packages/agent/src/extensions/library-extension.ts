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

const SKILL_AUTHORING_GUIDE =
	`When asked to create a library skill, use write to create ${LIBRARY_SKILLS_DIR}/<skill-name>/SKILL.md relative to the library root. ` +
	"Use a lowercase name with hyphens between words. Include YAML frontmatter with name matching the directory and description explaining when to use the skill. " +
	"Keep supporting files in the skill directory and reference them by relative path.";

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
				const { skills } = await loadLibrarySkills(input.env, root, context);
				const catalog = formatSkillsForSystemPrompt(skills);
				return catalog ? `${SKILL_AUTHORING_GUIDE}\n\n${catalog}` : SKILL_AUTHORING_GUIDE;
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
