export type SkillScope = "user" | "library";
export type SkillKind = "directory" | "file";

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const RESERVED_SKILL_NAMES = new Set(["compact"]);

export function isValidSkillName(name: string): boolean {
	return name.length > 0 && name.length <= SKILL_NAME_MAX_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function isReservedSkillName(name: string): boolean {
	return RESERVED_SKILL_NAMES.has(name);
}

export interface SkillSummary {
	/** Scope-relative POSIX path of the skill file (`<name>/SKILL.md` or `<file>.md`). */
	id: string;
	scope: SkillScope;
	kind: SkillKind;
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	enabled: boolean;
	disableModelInvocation: boolean;
	overriddenByLibrary: boolean;
	overridesUser: boolean;
	/** Count of extra files inside `baseDir` excluding `SKILL.md` (0 for standalone `.md`). */
	supportingFileCount: number;
}

export interface SkillDetail extends SkillSummary {
	content: string;
	/** Sorted POSIX paths of supporting files relative to `baseDir`. */
	supportingFiles: string[];
}

export interface SkillDiagnosticItem {
	scope: SkillScope;
	path: string;
	message: string;
}

export interface SkillsSettingsView {
	userDir: string;
	libraryDir: string | null;
	user: SkillSummary[];
	library: SkillSummary[];
	diagnostics: SkillDiagnosticItem[];
}

export interface CreateSkillInput {
	scope: SkillScope;
	name: string;
	description: string;
	content: string;
}

export interface UpdateSkillInput {
	scope: SkillScope;
	id: string;
	description: string;
	content: string;
}
