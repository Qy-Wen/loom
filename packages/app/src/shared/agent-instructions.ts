/** Same cap Claude Code uses for a CLAUDE.md file. */
export const INSTRUCTIONS_CHAR_LIMIT = 40_000;

export function instructionCharacterCount(text: string): number {
	return [...text].length;
}
