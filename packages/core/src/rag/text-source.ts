import { extname } from "node:path";

const INDEXABLE_TEXT = new Set([".md", ".txt", ".csv", ".json"]);

/** A JSON container this short becomes one passage; longer ones are split further. */
const JSON_BLOCK_CHARS = 1200;

export function canIndexText(filename: string): boolean {
	return INDEXABLE_TEXT.has(extname(filename).toLowerCase());
}

/**
 * Turn a text file into Markdown for chunking. Offsets only matter inside the
 * converted text, so structured formats are rewritten, not wrapped.
 *
 * Every CSV row and small JSON object becomes its own blank-line-separated
 * paragraph. The splitter breaks on block boundaries, so rows are never cut in
 * half, and each carries its own column names or key path.
 *
 * `truncated` means the source was cut at the extract limit, so its last row may be partial.
 */
export function textToMarkdown(filename: string, text: string, truncated = false): string {
	const extension = extname(filename).toLowerCase();
	if (extension === ".csv") return csvToMarkdown(text, truncated);
	if (extension === ".json") return jsonToMarkdown(text);
	return text;
}

export function csvToMarkdown(text: string, truncated = false): string {
	const rows = parseCsv(text.replace(/^\uFEFF/, ""));
	if (truncated && rows.length > 1) rows.pop();
	const header = rows.shift();
	if (!header) return "";
	const names = header.map((cell, index) => oneLine(cell) || `column ${index + 1}`);
	const paragraphs: string[] = [];
	for (const row of rows) {
		const fields: string[] = [];
		row.forEach((cell, index) => {
			const value = oneLine(cell);
			if (value) fields.push(`${names[index] ?? `column ${index + 1}`}: ${value}`);
		});
		if (fields.length > 0) paragraphs.push(fields.join("; "));
	}
	return paragraphs.length > 0 ? `${paragraphs.join("\n\n")}\n` : "";
}

export function jsonToMarkdown(text: string): string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return text; // Cut off or not JSON: still searchable as plain text.
	}
	const paragraphs: string[] = [];
	collectJson("", value, paragraphs);
	return paragraphs.length > 0 ? `${paragraphs.join("\n\n")}\n` : "";
}

function collectJson(path: string, value: unknown, paragraphs: string[]): void {
	const lines: string[] = [];
	flattenJson(path, value, lines);
	if (lines.length === 0) return;
	const joined = lines.join("\n");
	if (joined.length <= JSON_BLOCK_CHARS || !isContainer(value)) {
		paragraphs.push(joined);
		return;
	}
	for (const [key, child] of entriesOf(value)) {
		collectJson(Array.isArray(value) ? `${path}[${key}]` : joinPath(path, key), child, paragraphs);
	}
}

function flattenJson(path: string, value: unknown, lines: string[]): void {
	if (isContainer(value)) {
		for (const [key, child] of entriesOf(value)) {
			flattenJson(Array.isArray(value) ? `${path}[${key}]` : joinPath(path, key), child, lines);
		}
		return;
	}
	if (value === null || value === "") return;
	lines.push(`${path || "value"}: ${oneLine(String(value))}`);
}

function isContainer(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function entriesOf(value: object): [string, unknown][] {
	return Object.entries(value);
}

function joinPath(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** RFC 4180: quoted cells may hold commas, doubled quotes, and line breaks. */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	const endCell = (): void => { row.push(cell); cell = ""; };
	const endRow = (): void => { endCell(); rows.push(row); row = []; };
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (quoted) {
			if (char !== "\"") cell += char;
			else if (text[index + 1] === "\"") { cell += "\""; index += 1; }
			else quoted = false;
		} else if (char === "\"" && cell === "") quoted = true;
		else if (char === ",") endCell();
		else if (char === "\n") endRow();
		else if (char !== "\r") cell += char;
	}
	if (cell !== "" || row.length > 0) endRow();
	return rows.filter((cells) => cells.some((value) => value.trim() !== ""));
}
