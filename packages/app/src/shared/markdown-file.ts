import { TEXT_FILE_EDIT_LIMIT_BYTES } from "./text-file.ts";

/** Larger files are edited as source to avoid expensive live decorations. */
export const MARKDOWN_LIVE_LIMIT_BYTES = 2 * 1024 * 1024;
/** Larger files still open, but cannot be written by the editor. */
export const MARKDOWN_EDIT_LIMIT_BYTES = TEXT_FILE_EDIT_LIMIT_BYTES;

export function markdownAccess(byteLength: number): "live" | "source" | "read" {
	return byteLength > MARKDOWN_EDIT_LIMIT_BYTES ? "read"
		: byteLength > MARKDOWN_LIVE_LIMIT_BYTES ? "source" : "live";
}

export function isMarkdownFile(path: string): boolean {
	return /\.md$/i.test(path);
}
