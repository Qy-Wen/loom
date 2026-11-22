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

const plainTextExtensions = new Set([
	"txt", "log",
	"json", "jsonc", "jsonl", "csv", "tsv", "xml", "yaml", "yml",
	"ini", "toml", "conf", "cfg", "properties",
	"css", "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx",
	"py", "sh", "bat", "cmd", "ps1", "sql",
]);

export function isPlainTextFile(path: string): boolean {
	const extension = /\.([\w]+)$/.exec(path)?.[1];
	return extension !== undefined && plainTextExtensions.has(extension.toLowerCase());
}
