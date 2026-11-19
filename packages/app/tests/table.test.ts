import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { appendColumn, appendRow, cellChange, escapeCell, parseTable, type TextChange } from "../src/renderer/workbench/preview/table.ts";

function apply(text: string, ...changes: (TextChange | null)[]): string {
	let result = text;
	for (const change of changes.filter((c): c is TextChange => c !== null).sort((a, b) => b.from - a.from)) {
		result = result.slice(0, change.from) + change.insert + result.slice(change.to);
	}
	return result;
}

const TABLE = "| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 12 |";

test("a table is read into cells with their alignment", () => {
	const table = parseTable(TABLE)!;
	assert.equal(table.columns, 2);
	assert.deepEqual(table.aligns, ["left", "right"]);
	assert.deepEqual(table.rows.map((row) => row.cells.map((cell) => cell.text)), [["名称", "数量"], ["苹果", "3"], ["梨", "12"]]);
	const cell = table.rows[1].cells[0];
	assert.equal(TABLE.slice(cell.from, cell.to), "苹果");
});

test("text that is not a table is refused", () => {
	assert.equal(parseTable("| a | b |"), null);
	assert.equal(parseTable("| a | b |\n| x | y |"), null);
	assert.equal(parseTable("| a | b |\n| - |"), null);
	assert.equal(parseTable("a | b\n--- | ---\n1 | 2")?.columns, 2);
	// The preview reads `- | -` as a list item, so it is not a table here either.
	assert.equal(parseTable("a | b\n- | -\n1 | 2"), null);
});

test("an escaped pipe stays in its cell, and a pipe inside code splits it like the preview does", () => {
	assert.deepEqual(parseTable("| a \\| b | c |\n| - | - |\n| `x|y` | z |")!.rows.map((row) => row.cells.map((cell) => cell.text)), [["a \\| b", "c"], ["`x", "y`", "z"].slice(0, 2).length ? ["`x", "y`", "z"] : []]);
});

test("a row can be short, long, or lack its outer pipes", () => {
	const table = parseTable("a | b\n--- | ---\n1\n| 2 | 3 | 4 |\n|| x |")!;
	assert.deepEqual(table.rows.map((row) => row.cells.map((cell) => cell.text)), [["a", "b"], ["1"], ["2", "3", "4"], ["", "x"]]);
	assert.equal(table.rows[0].endsWithPipe, false);
	assert.equal(table.rows[2].endsWithPipe, true);
});

test("a blank line ends the table", () => {
	assert.equal(parseTable("| a |\n| - |\n| 1 |\n\n| 2 |")!.rows.length, 2);
});

test("editing a cell changes those characters and no others", () => {
	const table = parseTable(TABLE)!;
	assert.equal(apply(TABLE, cellChange(table, 1, 0, "香蕉")), TABLE.replace("苹果", "香蕉"));
	assert.equal(apply(TABLE, cellChange(table, 2, 1, "")), TABLE.replace("12", ""));
	assert.equal(cellChange(table, 1, 0, "苹果"), null);
	assert.equal(cellChange(table, 1, 0, "  苹果 "), null);
});

test("an empty cell is filled in with its spaces, and a short row grows up to the cell", () => {
	const text = "| a | b | c |\n| - | - | - |\n| 1 |  |\n| 2 |";
	const table = parseTable(text)!;
	assert.equal(apply(text, cellChange(table, 1, 1, "x")), "| a | b | c |\n| - | - | - |\n| 1 | x |\n| 2 |");
	assert.equal(apply(text, cellChange(table, 2, 2, "z")), "| a | b | c |\n| - | - | - |\n| 1 |  |\n| 2 | | z |");
	assert.equal(apply("a | b\n--- | ---\n1", cellChange(parseTable("a | b\n--- | ---\n1")!, 1, 1, "2")), "a | b\n--- | ---\n1 | 2 |");
});

test("what is typed in a cell is written so that it stays one cell", () => {
	assert.equal(escapeCell("a | b"), "a \\| b");
	assert.equal(escapeCell("a \\| b"), "a \\| b");
	assert.equal(escapeCell("一\n二"), "一 二");
	const table = parseTable(TABLE)!;
	const edited = apply(TABLE, cellChange(table, 1, 0, "x | y"));
	assert.deepEqual(parseTable(edited)!.rows[1].cells.map((cell) => cell.text), ["x \\| y", "3"]);
});

test("adding a row or a column gives a table the preview reads with one more line or column", () => {
	const table = parseTable(TABLE)!;
	const withRow = apply(TABLE, appendRow(table, TABLE.length));
	assert.equal(parseTable(withRow)!.rows.length, 4);
	const withColumn = apply(TABLE, ...appendColumn(table));
	const parsed = parseTable(withColumn)!;
	assert.equal(parsed.columns, 3);
	assert.deepEqual(parsed.aligns, ["left", "right", ""]);
	assert.ok(withColumn.startsWith("| 名称 | 数量 |  |\n| :--- | ---: | --- |\n| 苹果 | 3 |  |"));
	const bare = "a | b\n--- | ---\n1 | 2";
	assert.equal(parseTable(apply(bare, ...appendColumn(parseTable(bare)!)))!.columns, 3);
});

test("the editor and the preview cut the same samples into the same cells", () => {
	const md = new MarkdownIt({ html: false });
	const samples = [
		TABLE,
		"| a | b |\n| - | - |\n| 1 | 2 |",
		"a | b\n--- | ---\n1 | 2",
		"| a | b |\n| - | - |\n| a \\| b | z | extra |",
		"| a | b |\n| - | - |\n| 只一格",
		"| a | b |\n| - | - |\n| `x|y` | z |",
		"|a|b|\n|:-:|-:|\n||x|\n|1||",
		"| a | b |\n| - | - |\n|  |  |",
		"| a |\n| - |\n| 1 |\n| 2 |",
	];
	for (const text of samples) {
		const table = parseTable(text);
		assert.ok(table, text);
		const tokens = md.parse(text, {});
		const rows: string[][] = [];
		for (const token of tokens) {
			if (token.type === "tr_open") rows.push([]);
			else if (token.type === "inline" && rows.length) rows[rows.length - 1].push(token.content);
		}
		const mine = table.rows.map((row) => Array.from({ length: table.columns }, (_, column) => (row.cells[column]?.text ?? "").replace(/\\\|/g, "|")));
		assert.deepEqual(mine, rows, text);
	}
});
