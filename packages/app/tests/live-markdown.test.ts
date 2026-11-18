import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { liveDecorations } from "../src/renderer/workbench/preview/live-markdown.ts";

/** The decorations of `text` with the cursor at `cursor` (end of the text by default), as plain facts. */
function decorate(text: string, cursor = text.length, anchor = cursor) {
	const state = EditorState.create({
		doc: text,
		selection: EditorSelection.single(anchor, cursor),
		extensions: [markdown({ base: markdownLanguage })],
	});
	ensureSyntaxTree(state, state.doc.length, 5000);
	const hidden: string[] = [];
	const classes: string[] = [];
	const lines: string[] = [];
	liveDecorations(state).between(0, state.doc.length, (from, to, value) => {
		const name = (value.spec as { class?: string }).class ?? "";
		if (name === "cm-live-hidden") hidden.push(text.slice(from, to));
		else if (from === to) lines.push(`${name}@${state.doc.lineAt(from).number}`);
		else classes.push(`${name}:${text.slice(from, to)}`);
	});
	return { hidden, classes, lines };
}

test("symbols are hidden while the cursor is elsewhere, and the text between them is styled", () => {
	const text = "**粗** and *斜* and ~~删~~ and `码`\n\nend";
	const { hidden, classes } = decorate(text, text.length);
	assert.deepEqual(hidden, ["**", "**", "*", "*", "~~", "~~", "`", "`"]);
	assert.deepEqual(classes, ["cm-live-strong:粗", "cm-live-emphasis:斜", "cm-live-strike:删", "cm-live-code:码"]);
});

test("the symbols of an element come back when the cursor touches it", () => {
	const text = "a **b** c";
	assert.deepEqual(decorate(text, 0).hidden, ["**", "**"]);
	assert.deepEqual(decorate(text, 4).hidden, []);
	// Right next to the marks counts, so a mark can be reached from outside.
	assert.deepEqual(decorate(text, 2).hidden, []);
	assert.deepEqual(decorate(text, 7).hidden, []);
	// A selection across it too.
	assert.deepEqual(decorate(text, 9, 0).hidden, []);
});

test("only the element under the cursor shows its symbols", () => {
	const text = "**a** and **b**";
	assert.deepEqual(decorate(text, 3).hidden, ["**", "**"]);
	assert.equal(decorate(text, 3).classes.length, 2);
});

test("headings get a size class per level and hide the # marks until the cursor is on the line", () => {
	const text = "# One\n\n## Two\n\n###### Six";
	const away = decorate(text, text.indexOf("Six"));
	assert.deepEqual(away.hidden, ["# ", "## "]);
	assert.deepEqual(away.lines, ["cm-live-h1@1", "cm-live-h2@3", "cm-live-h6@5"]);
	assert.deepEqual(decorate(text, 2).hidden, ["## ", "###### "]);
	assert.deepEqual(decorate(text, text.indexOf("Two")).hidden, ["# ", "###### "]);
});

test("a link shows its text and hides the brackets and address", () => {
	const text = "see [文档](https://x.com \"t\") now";
	assert.deepEqual(decorate(text, text.length).hidden, ["[", "](https://x.com \"t\")"]);
	assert.deepEqual(decorate(text, text.length).classes, ["cm-live-link:文档"]);
	assert.deepEqual(decorate(text, 8).hidden, []);
});

test("an unfinished element is left as typed", () => {
	for (const text of ["**bold", "a `code", "[text](", "~~x"]) {
		assert.deepEqual(decorate(text, 0).hidden, [], text);
	}
});

test("code blocks and escaped text are not treated as Markdown", () => {
	const text = "```\n**no** `x` # no\n```\n\n\\*\\*no\\*\\*";
	const { hidden, classes } = decorate(text, text.length);
	assert.deepEqual(hidden, []);
	assert.deepEqual(classes, []);
});

test("decorating never changes the text", () => {
	const text = "# H\n\n**b** [l](u)\n";
	const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
	liveDecorations(state);
	assert.equal(state.doc.toString(), text);
});
