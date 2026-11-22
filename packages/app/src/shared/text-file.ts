/** `revision` identifies the exact bytes the editor read. */
export interface TextFileSnapshot {
	/** Text with the leading BOM removed and line breaks normalized to `\n`. */
	text: string;
	revision: string;
	byteLength: number;
}

export type TextFileSaveResult = { status: "saved"; snapshot: TextFileSnapshot } | { status: "conflict" };

export const TEXT_FILE_EDIT_LIMIT_BYTES = 10 * 1024 * 1024;

export function isHtmlFile(path: string): boolean {
	return /\.html?$/i.test(path);
}
