import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { MarkdownFormat } from "../src/shared/ipc.ts";
import { markdownFormatPlans } from "../src/renderer/workbench/preview/markdown-format.ts";

function select(doc: string, text: string) {
	const from = doc.indexOf(text);
	assert.ok(from >= 0);
	return EditorState.create({ doc, selection: { anchor: from, head: from + text.length }, extensions: [markdown({ base: markdownLanguage })] });
}

function apply(state: EditorState, format: MarkdownFormat) {
	const plan = markdownFormatPlans(state).get(format);
	const edit = plan?.transaction();
	assert.ok(edit, `missing ${format} edit for ${JSON.stringify(state.doc.toString())}`);
	return state.update(edit).state;
}

test("inline format toggles parsed delimiters and keeps the text selected", () => {
	const bold = apply(select("Before word after", "word"), "bold");
	assert.equal(bold.doc.toString(), "Before **word** after");
	assert.equal(bold.sliceDoc(bold.selection.main.from, bold.selection.main.to), "word");
	assert.equal(markdownFormatPlans(bold).get("bold")?.checked, true);
	assert.equal(apply(bold, "bold").doc.toString(), "Before word after");
	assert.equal(apply(select("__word__", "__word__"), "bold").doc.toString(), "word");
	assert.equal(apply(select("***word***", "word"), "italic").doc.toString(), "**word**");
	assert.equal(apply(select("A word here", "word"), "strikethrough").doc.toString(), "A ~~word~~ here");
	const code = apply(select("A tick` here", "tick`"), "inlineCode");
	assert.equal(code.doc.toString(), "A `` tick` `` here");
	assert.equal(apply(code, "inlineCode").doc.toString(), "A tick` here");
});

test("block formats convert complete paragraphs and preserve neighboring list items", () => {
	const heading = apply(select("First line\nsecond line\n\nUntouched\n", "second"), "heading2");
	assert.equal(heading.doc.toString(), "## First line second line\n\nUntouched\n");
	assert.equal(apply(heading, "paragraph").doc.toString(), "First line second line\n\nUntouched\n");
	assert.equal(apply(select("Setext title\n===\n", "title"), "heading2").doc.toString(), "## Setext title\n");
	assert.equal(apply(select("- A\n- B\n- C\n", "B"), "paragraph").doc.toString(), "- A\n\nB\n\n- C\n");
	const quote = apply(select("First\n\nSecond", "First\n\nSecond"), "quote");
	assert.equal(quote.doc.toString(), "> First\n>\n> Second");
	assert.equal(apply(quote, "paragraph").doc.toString(), "First\n\nSecond");
	assert.equal(apply(select("First\ncontinued\n\nSecond", "First\ncontinued\n\nSecond"), "ordered").doc.toString(), "1. First\n   continued\n2. Second");
	assert.equal(apply(select("- [x] Done\n- Next", "Done\n- Next"), "task").doc.toString(), "- [x] Done\n- [ ] Next");
});

test("formatting protects literal blocks and incomplete markup", () => {
	assert.equal(markdownFormatPlans(select("```js\nconst value = 1;\n```", "value")).size, 0);
	assert.equal(markdownFormatPlans(select("$$\nx + y\n$$", "x + y")).size, 0);
	assert.equal(markdownFormatPlans(select("| A | B |\n| --- | --- |\n| yes | no |", "yes")).size, 0);
	assert.equal(markdownFormatPlans(select("A [[reference]] here", "reference")).has("bold"), false);
	assert.equal(markdownFormatPlans(select("A **part** here", "**pa")).has("bold"), false);
	assert.equal(markdownFormatPlans(select("- Outer\n  - Nested", "Outer")).has("heading1"), false);
});
