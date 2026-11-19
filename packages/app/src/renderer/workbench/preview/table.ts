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
export function appendRow(table: ParsedTable, end: number, count = 1): TextChange {
	return { from: end, to: end, insert: `\n|${"  |".repeat(table.columns)}`.repeat(count) };
}

/** A new empty column after the last one, on every line that is as wide as the table. */
export function appendColumn(table: ParsedTable, count = 1): TextChange[] {
	const changes: TextChange[] = [];
	const add = (to: number, pipe: boolean, cell: string) => changes.push({ from: to, to, insert: pipe ? cell.repeat(count) : ` |${cell.repeat(count)}` });
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
export function removeRow(table: ParsedTable, row: number, text: string, last = row): TextChange | null {
	if (row <= 0 || row >= table.rows.length || last < row) return null;
	last = Math.min(last, table.rows.length - 1);
	// Row 0 is line 0 and the delimiter is line 1, so body row `n` is line `n + 1`.
	const starts = [0];
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
	const index = row + 1;
	const from = starts[index];
	if (from === undefined) return null;
	const next = starts[last + 2];
	// Lines in the middle take their own breaks; the last one takes the break in front of it.
	return next === undefined ? { from: from - 1, to: text.length, insert: "" } : { from, to: next, insert: "" };
}

/**
 * The edit that removes column `column` from the header, the delimiter row and every row that has it. A table of one
 * column keeps it. A row that is shorter than the column is left alone.
 */
export function removeColumn(table: ParsedTable, column: number, last = column): TextChange[] | null {
	last = Math.min(last, table.columns - 1);
	if (column < 0 || last < column || last - column + 1 >= table.columns) return null;
	const changes: TextChange[] = [];
	const cut = (cells: { segFrom: number; segTo: number }[], pipe: boolean) => {
		const cell = cells[column];
		if (!cell) return;
		const end = cells[Math.min(last, cells.length - 1)];
		// The pipe that closes the cells goes with them. A row without a closing pipe whose last cell goes takes the one before.
		if (last < cells.length - 1 || pipe) changes.push({ from: cell.segFrom, to: end.segTo + 1, insert: "" });
		else changes.push({ from: cells[column - 1] ? cells[column - 1].segTo : cell.segFrom - 1, to: end.segTo, insert: "" });
	};
	table.rows.forEach((row, index) => {
		cut(row.cells, row.endsWithPipe);
		if (index === 0) cut(table.delimiter.cells, table.delimiter.endsWithPipe);
	});
	return changes.sort((a, b) => a.from - b.from);
}

/** A block of cells, as the rows and columns it runs from and to, both ends included. The header is row 0. */
export interface CellRect {
	row1: number;
	column1: number;
	row2: number;
	column2: number;
}

/**
 * The cells of a block as the Markdown table they make: the header of the table's own columns over the block's rows,
 * and the alignment of each column. When the block does not take in the header row, the table's header is put on top
 * so that what is copied is a table of its own.
 */
export function rectText(table: ParsedTable, rect: CellRect): string {
	const columns = Array.from({ length: rect.column2 - rect.column1 + 1 }, (_, index) => rect.column1 + index);
	const line = (row: number) => `| ${columns.map((column) => table.rows[row]?.cells[column]?.text ?? "").join(" | ")} |`;
	const delimiter = `| ${columns.map((column) => delimiterFor(table.aligns[column] ?? "")).join(" | ")} |`;
	const lines = [line(0), delimiter];
	for (let row = Math.max(rect.row1, 1); row <= rect.row2; row++) lines.push(line(row));
	return lines.join("\n");
}

/** What the cells of a block hold, row by row, as written in the file. A cell a short row lacks holds nothing. */
export function cellTexts(table: ParsedTable, rect: CellRect): string[][] {
	const result: string[][] = [];
	for (let row = rect.row1; row <= rect.row2; row++) {
		const line: string[] = [];
		for (let column = rect.column1; column <= rect.column2; column++) line.push(table.rows[row]?.cells[column]?.text ?? "");
		result.push(line);
	}
	return result;
}

/**
 * The edits that write `values` into the cells from (`row`, `column`) on, one value to a cell. What would fall outside
 * the table is left out: the table keeps its shape. Several cells that a short row lacks are written by a single edit.
 */
export function setCells(table: ParsedTable, row: number, column: number, values: string[][]): TextChange[] {
	const changes: TextChange[] = [];
	values.forEach((line, offset) => {
		const index = row + offset;
		const target = table.rows[index];
		if (!target || index >= table.rows.length) return;
		const missing: string[] = [];
		line.forEach((value, step) => {
			const at = column + step;
			if (at >= table.columns) return;
			if (at < target.cells.length) {
				const change = cellChange(table, index, at, value);
				if (change) changes.push(change);
			} else {
				while (target.cells.length + missing.length < at) missing.push("");
				missing.push(escapeCell(value));
			}
		});
		// Empty cells at the end need no writing.
		while (missing.length && !missing[missing.length - 1]) missing.pop();
		if (missing.length) changes.push({ from: target.to, to: target.to, insert: `${target.endsWithPipe ? "" : " |"}${missing.map((value) => (value ? ` ${value} |` : " |")).join("")}` });
	});
	return changes.sort((a, b) => a.from - b.from);
}

function applyChanges(text: string, changes: TextChange[]): string {
	let result = text;
	for (const change of [...changes].sort((a, b) => b.from - a.from)) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
	return result;
}

/**
 * The edit that pastes `values` into the table with its top left cell at (`row`, `column`), as a table in a spreadsheet
 * takes them: what lies beyond the last column or row is added to the table first. The header row is a row like the
 * others to write into, but never one that is added. Returns one edit, from the first character that changes to the
 * last, or null when nothing does.
 */
export function pasteCells(text: string, row: number, column: number, values: string[][]): TextChange | null {
	let table = parseTable(text);
	if (!table || !values.length || row < 0 || column < 0 || row >= table.rows.length || column >= table.columns) return null;
	let next = text;
	const width = Math.max(...values.map((line) => line.length));
	const extraColumns = column + width - table.columns;
	if (extraColumns > 0) {
		next = applyChanges(next, appendColumn(table, extraColumns));
		table = parseTable(next);
	}
	const extraRows = table ? row + values.length - table.rows.length : 0;
	if (table && extraRows > 0) {
		next = applyChanges(next, [appendRow(table, next.length, extraRows)]);
		table = parseTable(next);
	}
	if (!table) return null;
	next = applyChanges(next, setCells(table, row, column, values));
	if (next === text) return null;
	// Only the stretch that differs, so that what the paste did not touch is not written again.
	let from = 0;
	while (from < text.length && from < next.length && text[from] === next[from]) from++;
	let end = 0;
	while (end < text.length - from && end < next.length - from && text[text.length - 1 - end] === next[next.length - 1 - end]) end++;
	return { from, to: text.length - end, insert: next.slice(from, next.length - end) };
}

/** The edits that empty every cell of a block, the header's included. Cells that are empty already are left out. */
export function clearCells(table: ParsedTable, rect: CellRect): TextChange[] {
	const changes: TextChange[] = [];
	for (let row = rect.row1; row <= rect.row2; row++) {
		for (let column = rect.column1; column <= rect.column2; column++) {
			const change = cellChange(table, row, column, "");
			if (change) changes.push(change);
		}
	}
	return changes;
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

/** Where `item` of `length` lands when it is taken out and put back at `to`, and the order that gives. */
function reorder<T>(items: T[], from: number, to: number): T[] {
	const result = items.slice();
	const [moved] = result.splice(from, 1);
	result.splice(to, 0, moved);
	return result;
}

/**
 * The edit that moves body row `from` to where `to` is, both counted as in the table (row 0 is the header and stays).
 * The lines are put in the new order as they are written, so each keeps its own spacing. Null when nothing moves.
 */
export function moveRow(table: ParsedTable, from: number, to: number, text: string): TextChange | null {
	const last = table.rows.length - 1;
	if (from === to || from < 1 || to < 1 || from > last || to > last) return null;
	// Row 0 is line 0 and the delimiter is line 1, so body row `n` is line `n + 1`.
	const starts = [0];
	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
	const lineEnd = (index: number) => (starts[index + 1] === undefined ? text.length : starts[index + 1] - 1);
	const low = Math.min(from, to) + 1;
	const high = Math.max(from, to) + 1;
	if (starts[low] === undefined || starts[high] === undefined) return null;
	const lines: string[] = [];
	for (let index = low; index <= high; index++) lines.push(text.slice(starts[index], lineEnd(index)));
	return { from: starts[low], to: lineEnd(high), insert: reorder(lines, from - low + 1, to - low + 1).join("\n") };
}

/**
 * The edit that moves column `from` to where `to` is. On every line the text of the cells from one to the other is put in
 * the new order, and the spaces around each cell stay at the place they were: a cell keeps its width and its pipes, so a
 * line with no outer pipes keeps none, and what the delimiter row says goes with the column. A row that has fewer cells
 * than the move reaches is left alone, as it is by the other column edits.
 */
export function moveColumn(table: ParsedTable, from: number, to: number, text: string): TextChange[] | null {
	if (from === to || from < 0 || to < 0 || from >= table.columns || to >= table.columns) return null;
	const low = Math.min(from, to);
	const high = Math.max(from, to);
	const changes: TextChange[] = [];
	const lines = [...table.rows.map((row) => row.cells), table.delimiter.cells];
	for (const cells of lines) {
		if (cells.length <= high) continue;
		// The cell as written, split into the spaces before it, its text and the spaces after it.
		const parts = cells.slice(low, high + 1).map((cell) => {
			const written = text.slice(cell.segFrom, cell.segTo);
			const core = written.trim();
			const lead = core ? written.length - written.trimStart().length : written.length;
			return { lead: written.slice(0, lead), core, trail: written.slice(lead + core.length) };
		});
		const cores = reorder(parts.map((part) => part.core), from - low, to - low);
		const pieces = parts.map((part, index) => {
			// A cell that was empty has spaces only; put its spacing together with the text that comes into it.
			const core = cores[index];
			if (!parts[index].core && core) return ` ${core} `;
			if (parts[index].core && !core) return `${part.lead}${part.trail}`;
			return `${part.lead}${core}${part.trail}`;
		});
		changes.push({ from: cells[low].segFrom, to: cells[high].segTo, insert: pieces.join("|") });
	}
	return changes.sort((a, b) => a.from - b.from);
}

/** A new empty row at body position `row` (1 is right under the header). The same as {@link appendRow} when it is past the end. */
export function insertRow(table: ParsedTable, row: number, text: string, count = 1): TextChange {
	if (row >= table.rows.length) return appendRow(table, text.length, count);
	// Before the line that is row `row`: row 0 is line 0 and the delimiter is line 1, so row `n` is line `n + 1`.
	let at = 0;
	for (let line = 0; line < row + 1; line++) at = text.indexOf("\n", at) + 1;
	// Empty cells, in the form the table is written in: with the outer pipes, or without.
	const outer = table.rows.every((r) => r.cells.length === 0 || r.endsWithPipe);
	const empty = Array(table.columns).fill("  ").join("|");
	return { from: at, to: at, insert: `${outer ? `|${empty}|` : empty}\n`.repeat(count) };
}

/**
 * A new empty column at position `column` (0 is before the first), on the header, the delimiter row and every row as
 * wide as the table. At the end it is {@link appendColumn}. In front of the first column a line without an outer pipe
 * would start with `|`, which the preview takes for an outer pipe and so for one column fewer. Such a line gets its
 * outer pipes first, which changes how it is written and not what it says.
 */
export function insertColumn(table: ParsedTable, column: number, text: string, count = 1): TextChange[] {
	if (column >= table.columns) return appendColumn(table, count);
	const changes: TextChange[] = [];
	const add = (cells: { segFrom: number; segTo: number }[], pipe: boolean, filler: string) => {
		const cell = cells[column];
		if (!cell) return;
		const startsLine = column === 0 && (cell.segFrom === 0 || text[cell.segFrom - 1] === "\n");
		if (startsLine && !leadingPipe(text, cell.segFrom)) {
			changes.push({ from: cell.segFrom, to: cell.segFrom, insert: `|${filler}|${`${filler}|`.repeat(count - 1)}` });
			if (!pipe) changes.push({ from: cells[cells.length - 1].segTo, to: cells[cells.length - 1].segTo, insert: " |" });
		} else {
			changes.push({ from: cell.segFrom, to: cell.segFrom, insert: `${filler}|`.repeat(count) });
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
