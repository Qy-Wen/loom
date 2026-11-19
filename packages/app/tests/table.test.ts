import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { appendColumn, appendRow, cellChange, cellTexts, clearCells, pasteCells, escapeCell, insertColumn, insertRow, moveColumn, moveRow, parseTable, rectText, removeColumn, removeRow, setAlign, setCells, type TextChange } from "../src/renderer/workbench/preview/table.ts";

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

/** The table as the cells and alignments it reads to. */
function shape(text: string): { aligns: string[]; rows: string[][] } {
	const table = parseTable(text)!;
	return { aligns: table.aligns, rows: table.rows.map((row) => Array.from({ length: table.columns }, (_, column) => row.cells[column]?.text ?? "")) };
}

test("moving a row puts the lines in the new order and leaves their spacing alone", () => {
	const text = "| 名称 | 数量 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨   | 12 |\n| 桃 | 7 |";
	const table = parseTable(text)!;
	assert.equal(apply(text, moveRow(table, 1, 3, text)), "| 名称 | 数量 |\n| :--- | ---: |\n| 梨   | 12 |\n| 桃 | 7 |\n| 苹果 | 3 |");
	assert.equal(apply(text, moveRow(table, 3, 1, text)), "| 名称 | 数量 |\n| :--- | ---: |\n| 桃 | 7 |\n| 苹果 | 3 |\n| 梨   | 12 |");
	assert.equal(apply(text, moveRow(table, 1, 2, text)), "| 名称 | 数量 |\n| :--- | ---: |\n| 梨   | 12 |\n| 苹果 | 3 |\n| 桃 | 7 |");
	// Nothing moves for the same place, the header or a row that is not there; the header cannot be a target either.
	assert.equal(moveRow(table, 2, 2, text), null);
	assert.equal(moveRow(table, 0, 2, text), null);
	assert.equal(moveRow(table, 2, 0, text), null);
	assert.equal(moveRow(table, 1, 4, text), null);
	// Only the lines between are touched.
	const change = moveRow(table, 1, 2, text)!;
	assert.equal(text.slice(0, change.from), "| 名称 | 数量 |\n| :--- | ---: |\n");
	assert.equal(text.slice(change.to), "\n| 桃 | 7 |");
	assert.deepEqual(shape(apply(text, moveRow(table, 1, 3, text))).rows.map((row) => row[0]), ["名称", "梨", "桃", "苹果"]);
});

test("moving a column takes its header, delimiter and cells, and its alignment goes with it", () => {
	const text = "| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
	const table = parseTable(text)!;
	assert.deepEqual(shape(apply(text, ...moveColumn(table, 0, 2, text)!)), { aligns: ["center", "right", "left"], rows: [["b", "c", "a"], ["2", "3", "1"], ["5", "6", "4"]] });
	assert.deepEqual(shape(apply(text, ...moveColumn(table, 2, 0, text)!)), { aligns: ["right", "left", "center"], rows: [["c", "a", "b"], ["3", "1", "2"], ["6", "4", "5"]] });
	assert.deepEqual(shape(apply(text, ...moveColumn(table, 1, 2, text)!)), { aligns: ["left", "right", "center"], rows: [["a", "c", "b"], ["1", "3", "2"], ["4", "6", "5"]] });
	assert.equal(moveColumn(table, 1, 1, text), null);
	assert.equal(moveColumn(table, 0, 3, text), null);
	assert.equal(moveColumn(table, -1, 1, text), null);
});

test("moving a column keeps the table readable when the pipes are missing", () => {
	const md = new MarkdownIt();
	const samples = [
		"a | b | c\n--- | :-: | ---:\n1 | 2 | 3",
		"|a|b|c|\n|-|-|-|\n|1|2|3|",
		"| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3",
		"| 甲 | 乙 | 丙 |\n| :--- | :---: | ---: |\n| 一 | 二 | 三 |",
		"| a | b | c |\n| --- | --- | --- |\n|  |  | z |",
	];
	for (const text of samples) {
		const before = shape(text);
		for (let from = 0; from < before.aligns.length; from++) {
			for (let to = 0; to < before.aligns.length; to++) {
				if (from === to) continue;
				const moved = apply(text, ...moveColumn(parseTable(text)!, from, to, text)!);
				const expected = (items: string[]) => { const copy = items.slice(); copy.splice(to, 0, copy.splice(from, 1)[0]); return copy; };
				const after = shape(moved);
				assert.deepEqual(after.aligns, expected(before.aligns), `${JSON.stringify(text)} ${from}->${to}`);
				assert.deepEqual(after.rows, before.rows.map(expected), `${JSON.stringify(text)} ${from}->${to}`);
				// The preview reads the result as the same table.
				const html = md.render(moved);
				assert.ok(html.includes("<table>"), JSON.stringify(moved));
				assert.equal((html.match(/<th[ >]/g) ?? []).length, before.aligns.length, JSON.stringify(moved));
			}
		}
	}
});

test("a row with fewer cells than the move reaches is left as it is", () => {
	const text = "| a | b | c |\n| --- | --- | --- |\n| 1 |\n| 4 | 5 |\n| 7 | 8 | 9 |";
	const table = parseTable(text)!;
	assert.equal(apply(text, ...moveColumn(table, 0, 2, text)!), "| b | c | a |\n| --- | --- | --- |\n| 1 |\n| 4 | 5 |\n| 8 | 9 | 7 |");
	// A move among the first two columns reaches the row with two cells but not the one with one.
	assert.equal(apply(text, ...moveColumn(table, 0, 1, text)!), "| b | a | c |\n| --- | --- | --- |\n| 1 |\n| 5 | 4 |\n| 8 | 7 | 9 |");
});

test("several rows and columns are removed at once", () => {
	const text = "| a | b | c | d |\n| --- | :-: | --- | ---: |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 | 7 | 8 |\n| 9 | 10 | 11 | 12 |";
	const table = parseTable(text)!;
	// Rows 1 and 2 together, from the middle of the table and from its end.
	assert.equal(apply(text, removeRow(table, 1, text, 2)), "| a | b | c | d |\n| --- | :-: | --- | ---: |\n| 9 | 10 | 11 | 12 |");
	assert.equal(apply(text, removeRow(table, 2, text, 3)), "| a | b | c | d |\n| --- | :-: | --- | ---: |\n| 1 | 2 | 3 | 4 |");
	// All the body rows go; the header stays. The header itself is never removed.
	assert.equal(apply(text, removeRow(table, 1, text, 3)), "| a | b | c | d |\n| --- | :-: | --- | ---: |");
	assert.equal(removeRow(table, 0, text, 2), null);
	// Columns 1 and 2 together: their alignment goes with them.
	const cut = apply(text, ...removeColumn(table, 1, 2)!);
	assert.equal(cut, "| a | d |\n| --- | ---: |\n| 1 | 4 |\n| 5 | 8 |\n| 9 | 12 |");
	assert.equal(apply(text, ...removeColumn(table, 2, 3)!), "| a | b |\n| --- | :-: |\n| 1 | 2 |\n| 5 | 6 |\n| 9 | 10 |");
	// A table needs a column, so taking them all is refused.
	assert.equal(removeColumn(table, 0, 3), null);
	// The same without outer pipes, where the last cell of a row has no pipe to take with it.
	const bare = "a | b | c\n--- | --- | ---\n1 | 2 | 3";
	// (A row that loses its last cells keeps the space that stood next to the pipe, as it does with one column.)
	const trimmed = (value: string) => value.split("\n").map((line) => line.trim()).join("\n");
	assert.equal(trimmed(apply(bare, ...removeColumn(parseTable(bare)!, 1, 2)!)), "a\n---\n1");
	assert.equal(trimmed(apply(bare, ...removeColumn(parseTable(bare)!, 0, 1)!)), "c\n---\n3");
	for (const sample of [text, bare]) {
		const t = parseTable(sample)!;
		for (let first = 0; first < t.columns; first++) for (let last = first; last < t.columns; last++) {
			const changes = removeColumn(t, first, last);
			if (first === 0 && last === t.columns - 1) { assert.equal(changes, null); continue; }
			const result = apply(sample, ...changes!);
			// One column without outer pipes is not a table in Markdown, as it is when a single column is removed.
			if (sample === bare && t.columns - (last - first + 1) === 1) continue;
			assert.equal(parseTable(result)?.columns, t.columns - (last - first + 1), `${first}-${last} of ${sample}`);
		}
	}
});

test("a block of cells is copied as a table of its own", () => {
	const table = parseTable("| 名称 | 数量 | 备注 |\n| :--- | ---: | :-: |\n| 苹果 | 3 | 红 |\n| 梨 | 12 | 黄 |")!;
	// Two body cells wide and tall: the header of those columns goes on top, with their alignment.
	assert.equal(rectText(table, { row1: 1, column1: 1, row2: 2, column2: 2 }), "| 数量 | 备注 |\n| ---: | :-: |\n| 3 | 红 |\n| 12 | 黄 |");
	assert.equal(rectText(table, { row1: 2, column1: 1, row2: 2, column2: 2 }), "| 数量 | 备注 |\n| ---: | :-: |\n| 12 | 黄 |");
	// A block that takes in the header row starts from it.
	assert.equal(rectText(table, { row1: 0, column1: 0, row2: 1, column2: 0 }), "| 名称 |\n| :--- |\n| 苹果 |");
	// One cell is a table of one.
	assert.equal(rectText(table, { row1: 1, column1: 2, row2: 1, column2: 2 }), "| 备注 |\n| :-: |\n| 红 |");
	// What is copied reads back as a table.
	assert.equal(parseTable(rectText(table, { row1: 1, column1: 0, row2: 2, column2: 2 }))?.rows.length, 3);
});

test("several rows and columns are inserted at once", () => {
	const text = "| a | b |\n| --- | :-: |\n| 1 | 2 |";
	const table = parseTable(text)!;
	const wide = parseTable(apply(text, ...insertColumn(table, 1, text, 2)))!;
	assert.equal(wide.columns, 4);
	assert.deepEqual(wide.aligns, ["", "", "", "center"]);
	assert.equal(parseTable(apply(text, insertRow(table, 1, text, 3)))?.rows.length, 5);
	assert.equal(parseTable(apply(text, insertRow(table, 2, text, 2)))?.rows.length, 4);
	assert.equal(parseTable(apply(text, ...appendColumn(table, 3)))?.columns, 5);
	// Every position and number, on the same samples as the single insert: the table stays a table of the right shape.
	for (const sample of [text, "a | b\n--- | ---\n1 | 2", "| a | b\n| --- | ---\n| 1 | 2"]) {
		const t = parseTable(sample)!;
		for (let count = 1; count <= 3; count++) {
			for (let at = 0; at <= t.columns; at++) assert.equal(parseTable(apply(sample, ...insertColumn(t, at, sample, count)))?.columns, t.columns + count, `column ${at} x${count} of ${sample}`);
			for (let at = 1; at <= t.rows.length; at++) assert.equal(parseTable(apply(sample, insertRow(t, at, sample, count)))?.rows.length, t.rows.length + count, `row ${at} x${count} of ${sample}`);
		}
	}
});

test("a block of cells is emptied without touching the others", () => {
	const text = "| 名称 | 数量 | 备注 |\n| :--- | ---: | :-: |\n| 苹果 | 3 | 红 |\n| 梨 | 12 | 黄 |";
	const table = parseTable(text)!;
	const cleared = apply(text, ...clearCells(table, { row1: 1, column1: 1, row2: 2, column2: 2 }));
	assert.deepEqual(parseTable(cleared)!.rows.map((row) => row.cells.map((cell) => cell.text)), [["名称", "数量", "备注"], ["苹果", "", ""], ["梨", "", ""]]);
	// The header can be emptied too, and a cell that is empty already adds no change.
	const header = apply(cleared, ...clearCells(parseTable(cleared)!, { row1: 0, column1: 0, row2: 1, column2: 2 }));
	assert.deepEqual(parseTable(header)!.rows.map((row) => row.cells.map((cell) => cell.text)), [["", "", ""], ["", "", ""], ["梨", "", ""]]);
	assert.equal(clearCells(parseTable(header)!, { row1: 0, column1: 1, row2: 1, column2: 2 }).length, 0);
});

test("cells are read from a block and written into another place", () => {
	const text = "| 名称 | 数量 | 备注 | 价格 |\n| :--- | ---: | :-: | --- |\n| 苹果 | 3 | 红 | 5 |\n| 梨 | 12 | 黄 | 6 |\n| 桃 | 7 | 粉 | 8 |\n| 李 | 9 | 紫 | 4 |";
	const table = parseTable(text)!;
	const block = cellTexts(table, { row1: 1, column1: 0, row2: 2, column2: 1 });
	assert.deepEqual(block, [["苹果", "3"], ["梨", "12"]]);
	// Written four rows down and two columns over; only the cells it covers change.
	const pasted = apply(text, ...setCells(table, 3, 2, block));
	assert.deepEqual(parseTable(pasted)!.rows.map((row) => row.cells.map((cell) => cell.text)), [
		["名称", "数量", "备注", "价格"], ["苹果", "3", "红", "5"], ["梨", "12", "黄", "6"], ["桃", "7", "苹果", "3"], ["李", "9", "梨", "12"],
	]);
	// The delimiter row, and the alignment with it, is untouched.
	assert.equal(pasted.split("\n")[1], "| :--- | ---: | :-: | --- |");
	// What does not fit is left out, and the table keeps its shape.
	const clipped = apply(text, ...setCells(table, 4, 3, block));
	assert.deepEqual(parseTable(clipped)!.rows[4].cells.map((cell) => cell.text), ["李", "9", "紫", "苹果"]);
	assert.equal(parseTable(clipped)!.rows.length, 5);
	assert.equal(setCells(table, 9, 0, block).length, 0);
	// A pipe that is already escaped stays one, and one that is not is escaped.
	assert.equal(apply(text, ...setCells(table, 1, 0, [["a \\| b", "c|d"]])).split("\n")[2], "| a \\| b | c\\|d | 红 | 5 |");
});

test("cells are written into rows that are short", () => {
	const text = "| a | b | c | d |\n| --- | --- | --- | --- |\n| 1 |\n| 2 | 3 | 4";
	const table = parseTable(text)!;
	const result = apply(text, ...setCells(table, 1, 1, [["x", "y", "z"], ["", "", "w"]]));
	assert.deepEqual(parseTable(result)!.rows.map((row) => row.cells.map((cell) => cell.text)), [["a", "b", "c", "d"], ["1", "x", "y", "z"], ["2", "", "", "w"]]);
	// Cells that are empty and lie past the end of a row write nothing.
	assert.equal(apply(text, ...setCells(table, 1, 2, [["", ""]])), text);
	// Every place and size, on a table that is full and on one without outer pipes: the same cells come back.
	for (const sample of [text, "| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |", "a | b | c\n--- | --- | ---\n1 | 2 | 3\n4 | 5 | 6"]) {
		const t = parseTable(sample)!;
		for (let row = 0; row < t.rows.length; row++) for (let column = 0; column < t.columns; column++) {
			const values = [["p", "q"], ["r", "s"]];
			const written = parseTable(apply(sample, ...setCells(t, row, column, values)))!;
			assert.equal(written.rows.length, t.rows.length);
			assert.equal(written.columns, t.columns);
			values.forEach((line, dy) => line.forEach((value, dx) => {
				if (row + dy < t.rows.length && column + dx < t.columns) assert.equal(written.rows[row + dy].cells[column + dx]?.text, value, `${row},${column} + ${dy},${dx} of ${sample}`);
			}));
		}
	}
});

test("cells pasted at a cell run to the right and down, and the table grows to hold them", () => {
	const text = "| 名称 | 数量 | 备注 |\n| :--- | ---: | :-: |\n| 苹果 | 3 | 红 |\n| 梨 | 12 | 黄 |";
	const cells = (value: string) => parseTable(value)!.rows.map((row) => row.cells.map((cell) => cell.text));
	const paste = (row: number, column: number, values: string[][]) => apply(text, pasteCells(text, row, column, values));
	// Inside the table: only the cells it covers change.
	assert.deepEqual(cells(paste(1, 1, [["a", "b"], ["c", "d"]])), [["名称", "数量", "备注"], ["苹果", "a", "b"], ["梨", "c", "d"]]);
	// Past the last column: columns are added, with an empty header and no alignment.
	const wide = paste(1, 2, [["a", "b", "c"]]);
	assert.deepEqual(cells(wide), [["名称", "数量", "备注", "", ""], ["苹果", "3", "a", "b", "c"], ["梨", "12", "黄", "", ""]]);
	assert.deepEqual(parseTable(wide)!.aligns, ["left", "right", "center", "", ""]);
	// Past the last row: rows are added.
	assert.deepEqual(cells(paste(2, 0, [["a", "b"], ["c", "d"], ["e", "f"]])), [["名称", "数量", "备注"], ["苹果", "3", "红"], ["a", "b", "黄"], ["c", "d", ""], ["e", "f", ""]]);
	// Past both: the corner is filled in by both.
	assert.deepEqual(cells(paste(2, 2, [["a", "b"], ["c", "d"]])), [["名称", "数量", "备注", ""], ["苹果", "3", "红", ""], ["梨", "12", "a", "b"], ["", "", "c", "d"]]);
	// Into the header too.
	assert.deepEqual(cells(paste(0, 0, [["x", "y"]])).slice(0, 2), [["x", "y", "备注"], ["苹果", "3", "红"]]);
	// A change that is one stretch of the text, and none when the cells already hold the values.
	assert.equal(pasteCells(text, 2, 0, [["梨"]]), null);
	const small = pasteCells(text, 2, 1, [["99"]])!;
	assert.equal(text.slice(small.from, small.to), "12");
	// Outside the table there is nowhere to paste.
	assert.equal(pasteCells(text, 9, 0, [["a"]]), null);
	assert.equal(pasteCells(text, 3, 0, [["a"]]), null);
	assert.equal(pasteCells(text, 0, 9, [["a"]]), null);
	assert.equal(pasteCells("不是表格", 0, 0, [["a"]]), null);
	// Every start and size, with and without outer pipes: a table of the right size with every pasted cell in place.
	for (const sample of [text, "a | b | c\n--- | --- | ---\n1 | 2 | 3\n4 | 5 | 6", "| a | b | c\n| --- | --- | ---\n| 1 | 2 | 3\n| 4 | 5 | 6", "| a | b |\n| - | - |\n| 1 |\n| 2 | 3 | 4"]) {
		const t = parseTable(sample)!;
		for (let row = 0; row < t.rows.length; row++) for (let column = 0; column < t.columns; column++) for (const [h, w] of [[1, 1], [2, 3], [4, 2]]) {
			const values = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => `v${y}${x}`));
			const result = apply(sample, pasteCells(sample, row, column, values));
			const read = parseTable(result);
			const label = `${row},${column} ${h}x${w} of ${sample}`;
			assert.ok(read, label);
			assert.equal(read.rows.length, Math.max(t.rows.length, row + h), label);
			assert.equal(read.columns, Math.max(t.columns, column + w), label);
			values.forEach((line, y) => line.forEach((value, x) => assert.equal(read.rows[row + y].cells[column + x]?.text, value, `${label} at ${y},${x}`)));
			// The cells that the paste does not reach are as they were.
			t.rows.forEach((line, y) => line.cells.forEach((cell, x) => {
				if (y >= row && y < row + h && x >= column && x < column + w) return;
				assert.equal(read.rows[y].cells[x]?.text, cell.text, `${label} kept ${y},${x}`);
			}));
		}
	}
});
