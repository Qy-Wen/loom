import { join } from "node:path";
import {
	formatSkillsForSystemPrompt,
	loadSkills,
	type Context,
	type ExecutionEnv,
	type Skill,
	type SkillDiagnostic,
} from "#vendor/pi-agent";

export type { Skill, SkillDiagnostic };

/** Agent Skills root inside the open library. Not created automatically. */
export const LIBRARY_SKILLS_DIR = ".agents/skills";

export async function loadLibrarySkills(
	env: ExecutionEnv,
	libraryRoot: string,
	context: Context,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	return loadSkills(env, join(libraryRoot, LIBRARY_SKILLS_DIR), context);
}

/** Append the Agent Skills catalog. Full SKILL.md bodies stay out of the system prompt. */
export function systemPromptWithSkills(base: string, skills: Skill[]): string {
	const block = formatSkillsForSystemPrompt(skills);
	return block ? `${base}\n\n${block}` : base;
}
