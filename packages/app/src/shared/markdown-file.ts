/** What the editor reads from a Markdown file. `revision` identifies the exact bytes it came from. */
export interface MarkdownSnapshot {
	/** The text with a leading BOM removed and every line break written as `\n`. */
	text: string;
	revision: string;
}

/** The result of a save: the new snapshot, or `conflict` when the file on disk is no longer the one that was read. */
export type MarkdownSaveResult = { status: "saved"; snapshot: MarkdownSnapshot } | { status: "conflict" };

/** A Markdown file larger than this is shown read-only. */
export const MARKDOWN_EDIT_LIMIT_BYTES = 2 * 1024 * 1024;

export function isMarkdownFile(path: string): boolean {
	return /\.md$/i.test(path);
}
