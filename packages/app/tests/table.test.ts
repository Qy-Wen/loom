import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { appendColumn, appendRow, cellChange, escapeCell, insertColumn, insertRow, parseTable, removeColumn, removeRow, setAlign, type TextChange } from "../src/renderer/workbench/preview/table.ts";

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

test("removing a row takes that line and nothing else, and the header stays", () => {
	const table = parseTable(TABLE)!;
	assert.equal(apply(TABLE, removeRow(table, 1, TABLE)), "| 名称 | 数量 |\n| :--- | ---: |\n| 梨 | 12 |");
	assert.equal(apply(TABLE, removeRow(table, 2, TABLE)), "| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |");
	assert.equal(removeRow(table, 0, TABLE), null);
	assert.equal(removeRow(table, 3, TABLE), null);
	// With nothing but the header left, it is still a table.
	const two = "| a | b |\n| - | - |\n| 1 | 2 |";
	assert.equal(parseTable(apply(two, removeRow(parseTable(two)!, 1, two)))!.rows.length, 1);
});

test("removing a column takes it from the header, the delimiter and every row", () => {
	const cases: [string, number, string][] = [
		[TABLE, 0, "| 数量 |\n| ---: |\n| 3 |\n| 12 |"],
		[TABLE, 1, "| 名称 |\n| :--- |\n| 苹果 |\n| 梨 |"],
		["| a | b | c |\n| - | :-: | -: |\n| 1 | 2 | 3 |", 1, "| a | c |\n| - | -: |\n| 1 | 3 |"],
		["a | b | c\n--- | --- | ---\n1 | 2 | 3", 2, "a | b\n--- | ---\n1 | 2"],
		["a | b | c\n--- | --- | ---\n1 | 2 | 3", 0, " b | c\n --- | ---\n 2 | 3"],
		["| a | b |\n| - | - |\n| 1 |\n| 2 | 3 | 4 |", 1, "| a |\n| - |\n| 1 |\n| 2 | 4 |"],
	];
	for (const [text, column, expected] of cases) {
		const result = apply(text, ...removeColumn(parseTable(text)!, column)!);
		const parsed = parseTable(result)!;
		assert.ok(parsed, result);
		assert.equal(parsed.columns, parseTable(text)!.columns - 1, result);
		// Spaces are not what this checks: a cell that loses its neighbour may keep or lose one beside it.
		const plain = (value: string) => value.split("\n").map((line) => line.replace(/ +/g, " ").trim()).join("\n");
		assert.equal(plain(result), plain(expected), result);
	}
	// A table of one column keeps it.
	assert.equal(removeColumn(parseTable("| a |\n| - |\n| 1 |")!, 0), null);
});

test("what is left after removing is read by the preview as the same table without that row or column", () => {
	const md = new MarkdownIt({ html: false });
	const cells = (text: string) => [...md.render(text).matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((m) => m[1]);
	const table = parseTable(TABLE)!;
	assert.deepEqual(cells(apply(TABLE, removeRow(table, 1, TABLE))), ["名称", "数量", "梨", "12"]);
	assert.deepEqual(cells(apply(TABLE, ...removeColumn(table, 0)!)), ["数量", "3", "12"]);
});

test("a row or a column can be put in anywhere, and the table keeps its shape", () => {
	const table = parseTable(TABLE)!;
	assert.equal(apply(TABLE, insertRow(table, 1, TABLE)), "| 名称 | 数量 |\n| :--- | ---: |\n|  |  |\n| 苹果 | 3 |\n| 梨 | 12 |");
	assert.equal(apply(TABLE, insertRow(table, 2, TABLE)), "| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n|  |  |\n| 梨 | 12 |");
	assert.equal(apply(TABLE, insertRow(table, 3, TABLE)), apply(TABLE, appendRow(table, TABLE.length)));
	const left = parseTable(apply(TABLE, ...insertColumn(table, 0, TABLE)))!;
	assert.equal(left.columns, 3);
	assert.deepEqual(left.aligns, ["", "left", "right"]);
	assert.deepEqual(left.rows.map((row) => row.cells.map((cell) => cell.text)), [["", "名称", "数量"], ["", "苹果", "3"], ["", "梨", "12"]]);
	const middle = parseTable(apply(TABLE, ...insertColumn(table, 1, TABLE)))!;
	assert.deepEqual(middle.aligns, ["left", "", "right"]);
	assert.deepEqual(middle.rows.map((row) => row.cells.map((cell) => cell.text)), [["名称", "", "数量"], ["苹果", "", "3"], ["梨", "", "12"]]);
	assert.equal(apply(TABLE, ...insertColumn(table, 2, TABLE)), apply(TABLE, ...appendColumn(table)));
	// Without outer pipes.
	const bare = "a | b\n--- | ---\n1 | 2";
	const bareLeft = parseTable(apply(bare, ...insertColumn(parseTable(bare)!, 0, bare)))!;
	assert.deepEqual(bareLeft.rows.map((row) => row.cells.map((cell) => cell.text)), [["", "a", "b"], ["", "1", "2"]]);
	const bareMiddle = parseTable(apply(bare, ...insertColumn(parseTable(bare)!, 1, bare)))!;
	assert.deepEqual(bareMiddle.rows.map((row) => row.cells.map((cell) => cell.text)), [["a", "", "b"], ["1", "", "2"]]);
	assert.equal(parseTable(apply(bare, insertRow(parseTable(bare)!, 1, bare)))!.rows.length, 3);
});

test("an alignment is written in the delimiter row alone, and the preview reads it back", () => {
	const md = new MarkdownIt();
	const apply = (text: string, column: number, align: "left" | "right" | "center" | "") => {
		const change = setAlign(parseTable(text)!, column, align, text)!;
		return text.slice(0, change.from) + change.insert + text.slice(change.to);
	};
	const text = "| a | b | c |\n| --- | :-: | ---: |\n| 1 | 2 | 3 |";
	assert.equal(apply(text, 0, "right"), "| a | b | c |\n| ---: | :-: | ---: |\n| 1 | 2 | 3 |");
	assert.equal(apply(text, 1, ""), "| a | b | c |\n| --- | --- | ---: |\n| 1 | 2 | 3 |");
	assert.equal(apply(text, 2, "center"), "| a | b | c |\n| --- | :-: | :-: |\n| 1 | 2 | 3 |");
	assert.equal(apply(text, 0, "left"), "| a | b | c |\n| :--- | :-: | ---: |\n| 1 | 2 | 3 |");
	// Without outer pipes, or with a wide cell: the spaces and the pipes stay where they are.
	assert.equal(apply("a | b\n--- | ---\n1 | 2", 1, "right"), "a | b\n--- | ---:\n1 | 2");
	assert.equal(apply("|a|b|\n|-|-|\n|1|2|", 0, "center"), "|a|b|\n|:-:|-|\n|1|2|");
	assert.equal(apply("| a | b |\n|  ------  |  --  |\n| 1 | 2 |", 0, "left"), "| a | b |\n|  :---  |  --  |\n| 1 | 2 |");
	// What was written is read as that alignment, by us and by the preview.
	for (const align of ["left", "right", "center", ""] as const) {
		const changed = apply(text, 0, align);
		assert.equal(parseTable(changed)!.aligns[0], align);
		const html = md.render(changed);
		const expected = align ? `style="text-align:${align}"` : "";
		assert.ok(align ? html.includes(expected) : !/<th style="text-align:[a-z]+">a/.test(html), `${align}: ${html}`);
	}
	assert.equal(setAlign(parseTable(text)!, 3, "left", text), null);
});
