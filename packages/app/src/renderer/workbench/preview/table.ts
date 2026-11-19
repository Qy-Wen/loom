/**
 * A Markdown table as cells with their positions in the text, and the text edits that change it. Cells are cut
 * the way the preview's parser cuts them (`|` splits, `\|` does not, the outer pipes are optional), so the editor
 * and the preview agree on what a table is. Offsets are relative to the text of the table.
 */

export type TableAlign = "left" | "right" | "center" | "";

export interface TableCell {
	/** The cell as written between two pipes, spaces included. */
	segFrom: number;
	segTo: number;
	/** The text of the cell without the spaces around it. An empty cell has `from === to`. */
	from: number;
	to: number;
	text: string;
}

export interface TableRow {
	cells: TableCell[];
	/** End of the row's last character, trailing spaces excluded. */
	to: number;
	endsWithPipe: boolean;
}

export interface ParsedTable {
	columns: number;
	aligns: TableAlign[];
	/** The header first, then the body rows. */
	rows: TableRow[];
	/** The delimiter row, with each of its columns as written between two pipes. */
	delimiter: { cells: { segFrom: number; segTo: number }[]; from: number; to: number; endsWithPipe: boolean };
}

/** Where each `|`-separated piece of a line starts and ends. A `\|` does not split. */
function pieces(line: string): { from: number; to: number }[] {
	const found: { from: number; to: number }[] = [];
	let start = 0;
	let escaped = false;
	for (let at = 0; at < line.length; at++) {
		const char = line[at];
		if (char === "|" && !escaped) {
			found.push({ from: start, to: at });
			start = at + 1;
		}
		escaped = char === "\\";
	}
	found.push({ from: start, to: line.length });
	return found;
}

function endsWithPipe(line: string): boolean {
	const trimmed = line.trimEnd();
	if (!trimmed.endsWith("|")) return false;
	let slashes = 0;
	for (let at = trimmed.length - 2; at >= 0 && trimmed[at] === "\\"; at--) slashes++;
	return slashes % 2 === 0;
}

function parseRow(line: string, lineStart: number): TableRow {
	const lead = line.length - line.trimStart().length;
	const trimmed = line.trim();
	const base = lineStart + lead;
	const found = pieces(trimmed);
	if (found.length && found[0].from === found[0].to) found.shift();
	if (found.length && found[found.length - 1].from === found[found.length - 1].to) found.pop();
	const cells = found.map((piece): TableCell => {
		const raw = trimmed.slice(piece.from, piece.to);
		const text = raw.trim();
		const before = raw.length - raw.trimStart().length;
		const from = text ? base + piece.from + before : base + piece.from;
		return { segFrom: base + piece.from, segTo: base + piece.to, from, to: text ? from + text.length : from, text };
	});
	return { cells, to: base + trimmed.length, endsWithPipe: endsWithPipe(trimmed) };
}

/** The alignments a delimiter row (`| --- | :-: |`) names, or null when it is not one. */
function parseDelimiter(line: string): TableAlign[] | null {
	// The preview's first checks: only `|`, `-`, `:` and spaces, opening with one of the three and not like a list item (`- `).
	const trimmed = line.trim();
	if (line.length - line.trimStart().length >= 4) return null;
	if (trimmed.length < 2 || !/^[|:-]/.test(trimmed) || !/^[|:\- \t]+$/.test(trimmed)) return null;
	if (trimmed[0] === "-" && /\s/.test(trimmed[1])) return null;
	const aligns: TableAlign[] = [];
	const columns = trimmed.split("|");
	for (let at = 0; at < columns.length; at++) {
		const piece = columns[at].trim();
		if (!piece) {
			if (at === 0 || at === columns.length - 1) continue;
			return null;
		}
		if (!/^:?-+:?$/.test(piece)) return null;
		if (piece.endsWith(":")) aligns.push(piece.startsWith(":") ? "center" : "right");
		else aligns.push(piece.startsWith(":") ? "left" : "");
	}
	return aligns;
}

/** Reads a table the way the preview does. Returns null when the text is not a table. */
export function parseTable(text: string): ParsedTable | null {
	const lines = text.split("\n");
	if (lines.length < 2 || !lines[0].includes("|")) return null;
	const aligns = parseDelimiter(lines[1]);
	if (!aligns) return null;
	let start = 0;
	const rows: TableRow[] = [];
	let delimiter: ParsedTable["delimiter"] | null = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (index === 1) {
			const row = parseRow(line, start);
			delimiter = { cells: row.cells.map((cell) => ({ segFrom: cell.segFrom, segTo: cell.segTo })), from: start, to: start + line.trimEnd().length, endsWithPipe: endsWithPipe(line) };
		} else {
			if (index > 1 && !line.trim()) break;
			rows.push(parseRow(line, start));
		}
		start += line.length + 1;
	}
	const columns = rows[0].cells.length;
	if (columns === 0 || columns !== aligns.length || !delimiter) return null;
	return { columns, aligns, rows, delimiter };
}

/** What a cell holds once the preview has read it: the text with `\|` turned into `|`. */
export function cellSource(cell: string): string {
	return cell.replace(/\\\|/g, "|");
}

/** Cell text as it may be written: one line, and every `|` escaped. */
export function escapeCell(text: string): string {
	let result = "";
	let escaped = false;
	for (const char of text.replace(/\s*\n\s*/g, " ").trim()) {
		result += char === "|" && !escaped ? "\\|" : char;
		escaped = char === "\\" && !escaped;
	}
	return result;
}

export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

/**
 * The edit that makes cell (`row`, `column`) hold `text`, touching nothing else. A row that has fewer cells
 * than the table has columns is filled up as far as the cell. Returns null when nothing changes.
 */
export function cellChange(table: ParsedTable, row: number, column: number, text: string): TextChange | null {
	const line = table.rows[row];
	const value = escapeCell(text);
	const cell = line?.cells[column];
	if (!line) return null;
	if (cell) {
		if (value === cell.text) return null;
		if (value && cell.text) return { from: cell.from, to: cell.to, insert: value };
		if (value) return { from: cell.segFrom, to: cell.segTo, insert: ` ${value} ` };
		return { from: cell.from, to: cell.to, insert: "" };
	}
	if (!value) return null;
	const missing = column - line.cells.length;
	const insert = `${line.endsWithPipe ? "" : " |"}${" |".repeat(missing)} ${value} |`;
	return { from: line.to, to: line.to, insert };
}

/** A new empty row after the last one. `end` is where the table ends, in the table's own offsets. */
export function appendRow(table: ParsedTable, end: number): TextChange {
	return { from: end, to: end, insert: `\n|${"  |".repeat(table.columns)}` };
}

/** A new empty column after the last one, on every line that is as wide as the table. */
export function appendColumn(table: ParsedTable): TextChange[] {
	const changes: TextChange[] = [];
	const add = (to: number, pipe: boolean, cell: string) => changes.push({ from: to, to, insert: pipe ? cell : ` |${cell}` });
	table.rows.forEach((row, index) => {
		if (row.cells.length === table.columns) add(row.to, row.endsWithPipe, "  |");
		if (index === 0) add(table.delimiter.to, table.delimiter.endsWithPipe, " --- |");
	});
	return changes.sort((a, b) => a.from - b.from);
}

/**
 * The edit that removes body row `row` and its line break. The header, row 0, stays: without it there is no table.
 * Rows are told apart by their lines in `text`, the text of the table.
 */
export function removeRow(table: ParsedTable, row: number, text: string): TextChange | null {
	if (row <= 0 || row >= table.rows.length) return null;
	// Row 0 is line 0 and the delimiter is line 1, so body row `n` is line `n + 1`.
	const starts = [0];
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
	const index = row + 1;
	const from = starts[index];
	if (from === undefined) return null;
	const next = starts[index + 1];
	// A line in the middle takes its own break; the last one takes the break in front of it.
	return next === undefined ? { from: from - 1, to: text.length, insert: "" } : { from, to: next, insert: "" };
}

/**
 * The edit that removes column `column` from the header, the delimiter row and every row that has it. A table of one
 * column keeps it. A row that is shorter than the column is left alone.
 */
export function removeColumn(table: ParsedTable, column: number): TextChange[] | null {
	if (table.columns <= 1 || column < 0 || column >= table.columns) return null;
	const changes: TextChange[] = [];
	const cut = (cells: { segFrom: number; segTo: number }[], pipe: boolean) => {
		const cell = cells[column];
		if (!cell) return;
		// The pipe that closes the cell goes with it. The last cell of a row without a closing pipe takes the one before.
		if (column < cells.length - 1 || pipe) changes.push({ from: cell.segFrom, to: cell.segTo + 1, insert: "" });
		else changes.push({ from: cells[column - 1] ? cells[column - 1].segTo : cell.segFrom - 1, to: cell.segTo, insert: "" });
	};
	table.rows.forEach((row, index) => {
		cut(row.cells, row.endsWithPipe);
		if (index === 0) cut(table.delimiter.cells, table.delimiter.endsWithPipe);
	});
	return changes.sort((a, b) => a.from - b.from);
}

/** The delimiter cell that stands for an alignment: `---`, `:---`, `:-:` or `---:`. */
function delimiterFor(align: TableAlign): string {
	switch (align) {
		case "left": return ":---";
		case "center": return ":-:";
		case "right": return "---:";
		default: return "---";
	}
}

/**
 * The edit that sets the alignment of column `column`, which is written in the delimiter row alone. The spaces around
 * the cell stay as they are. Null when the column is not in the table.
 */
export function setAlign(table: ParsedTable, column: number, align: TableAlign, text: string): TextChange | null {
	const cell = table.delimiter.cells[column];
	if (!cell || column < 0 || column >= table.columns) return null;
	const written = text.slice(cell.segFrom, cell.segTo);
	const lead = written.length - written.trimStart().length;
	const trail = written.length - written.trimEnd().length;
	return { from: cell.segFrom + lead, to: cell.segTo - trail, insert: delimiterFor(align) };
}

/** A new empty row at body position `row` (1 is right under the header). The same as {@link appendRow} when it is past the end. */
export function insertRow(table: ParsedTable, row: number, text: string): TextChange {
	if (row >= table.rows.length) return appendRow(table, text.length);
	// Before the line that is row `row`: row 0 is line 0 and the delimiter is line 1, so row `n` is line `n + 1`.
	let at = 0;
	for (let line = 0; line < row + 1; line++) at = text.indexOf("\n", at) + 1;
	// Empty cells, in the form the table is written in: with the outer pipes, or without.
	const outer = table.rows.every((r) => r.cells.length === 0 || r.endsWithPipe);
	const empty = Array(table.columns).fill("  ").join("|");
	return { from: at, to: at, insert: `${outer ? `|${empty}|` : empty}\n` };
}

/**
 * A new empty column at position `column` (0 is before the first), on the header, the delimiter row and every row as
 * wide as the table. At the end it is {@link appendColumn}. In front of the first column a line without an outer pipe
 * would start with `|`, which the preview takes for an outer pipe and so for one column fewer. Such a line gets its
 * outer pipes first, which changes how it is written and not what it says.
 */
export function insertColumn(table: ParsedTable, column: number, text: string): TextChange[] {
	if (column >= table.columns) return appendColumn(table);
	const changes: TextChange[] = [];
	const add = (cells: { segFrom: number; segTo: number }[], pipe: boolean, filler: string) => {
		const cell = cells[column];
		if (!cell) return;
		const startsLine = column === 0 && (cell.segFrom === 0 || text[cell.segFrom - 1] === "\n");
		if (startsLine && !leadingPipe(text, cell.segFrom)) {
			changes.push({ from: cell.segFrom, to: cell.segFrom, insert: `|${filler}|` });
			if (!pipe) changes.push({ from: cells[cells.length - 1].segTo, to: cells[cells.length - 1].segTo, insert: " |" });
		} else {
			changes.push({ from: cell.segFrom, to: cell.segFrom, insert: `${filler}|` });
		}
	};
	table.rows.forEach((row, index) => {
		if (row.cells.length === table.columns) add(row.cells, row.endsWithPipe, "  ");
		if (index === 0) add(table.delimiter.cells, table.delimiter.endsWithPipe, " --- ");
	});
	return changes.sort((a, b) => a.from - b.from);
}

/** True when the line that starts at `at` (or after the spaces there) opens with a pipe. */
function leadingPipe(text: string, at: number): boolean {
	return text[at - 1] === "|" || /^\s*\|/.test(text.slice(at, text.indexOf("\n", at) === -1 ? undefined : text.indexOf("\n", at)));
}
