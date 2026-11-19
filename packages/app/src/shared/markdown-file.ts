/** What the editor reads from a Markdown file. `revision` identifies the exact bytes it came from. */
export interface MarkdownSnapshot {
	/** The text with a leading BOM removed and every line break written as `\n`. */
	text: string;
	revision: string;
	/** Exact file size on disk, including its BOM and line breaks. */
	byteLength: number;
}

/** The result of a save: the new snapshot, or `conflict` when the file on disk is no longer the one that was read. */
export type MarkdownSaveResult = { status: "saved"; snapshot: MarkdownSnapshot } | { status: "conflict" };

/** Larger files are edited as source to avoid expensive live decorations. */
export const MARKDOWN_LIVE_LIMIT_BYTES = 2 * 1024 * 1024;
/** Larger files still open, but cannot be written by the editor. */
export const MARKDOWN_EDIT_LIMIT_BYTES = 10 * 1024 * 1024;

export function markdownAccess(byteLength: number): "live" | "source" | "read" {
	return byteLength > MARKDOWN_EDIT_LIMIT_BYTES ? "read"
		: byteLength > MARKDOWN_LIVE_LIMIT_BYTES ? "source" : "live";
}

export function isMarkdownFile(path: string): boolean {
	return /\.md$/i.test(path);
}
