import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Asset } from "@loom/core";
import { liveBlockDecorations, liveBlocks, liveDecorations, liveDrag, setFocused, snapToSymbols, liveLibrary, updateLibrary } from "../src/renderer/workbench/preview/live-markdown.ts";

const asset = (assetId: string, relativePath: string): Asset => ({
	assetId, relativePath, filename: relativePath.split("/").pop()!, type: relativePath.endsWith(".png") ? "image" : "text",
	size: 1, createdAt: 1, modifiedAt: 2,
});
const LIBRARY = {
	fromRelativePath: "脚本.md",
	assets: [asset("notes", "产品说明.md"), asset("deep", "产品/说明.md"), asset("pic", "图/架构图.png"), asset("self", "脚本.md")],
};

/** The decorations of `text` with the cursor at `cursor` (end of the text by default), as plain facts. */
/** What the block layer replaces, as `text=>Widget`. */
function blocks(text: string, cursor = text.length) {
	const state = EditorState.create({
		doc: text,
		selection: EditorSelection.single(cursor),
		extensions: [markdown({ base: markdownLanguage })],
	});
	ensureSyntaxTree(state, state.doc.length, 5000);
	const out: string[] = [];
	liveBlockDecorations(state).between(0, state.doc.length, (from, to, value) => {
		out.push(`${text.slice(from, to)}=>${(value.spec as { widget: { constructor: { name: string } } }).widget.constructor.name}`);
	});
	return out;
}

function decorate(text: string, cursor = text.length, anchor = cursor, library = LIBRARY, readOnly = false) {
	let state = EditorState.create({
		doc: text,
		selection: EditorSelection.single(anchor, cursor),
		extensions: [markdown({ base: markdownLanguage }), liveLibrary, EditorState.readOnly.of(readOnly)],
	});
	if (library) state = state.update({ effects: updateLibrary(library) }).state;
	ensureSyntaxTree(state, state.doc.length, 5000);
	const hidden: string[] = [];
	const classes: string[] = [];
	const lines: string[] = [];
	const widgets: string[] = [];
	const targets: string[] = [];
	liveDecorations(state).between(0, state.doc.length, (from, to, value) => {
		const spec = value.spec as { class?: string; widget?: { src?: string; assetId?: string }; attributes?: Record<string, string> };
		const name = spec.class ?? spec.attributes?.class ?? "";
		if (spec.widget) {
			const target = spec.widget.assetId ? `asset:${spec.widget.assetId}` : spec.widget.src ?? spec.widget.constructor.name;
			widgets.push(`${text.slice(from, to)}=>${target}`);
		}
		else if (name === "cm-live-hidden") hidden.push(text.slice(from, to));
		else if (from === to) lines.push(`${name}@${state.doc.lineAt(from).number}`);
		else {
			classes.push(`${name}:${text.slice(from, to)}`);
			if (spec.attributes) targets.push(`${text.slice(from, to)}->${spec.attributes["data-asset-id"] ?? "none"}${spec.attributes["data-anchor"] ? `#${spec.attributes["data-anchor"]}` : ""}`);
		}
	});
	return { hidden, classes, lines, widgets, targets };
}

test("symbols are hidden while the cursor is elsewhere, and the text between them is styled", () => {
	const text = "**粗** and *斜* and ~~删~~ and `码`\n\nend";
	const { hidden, classes } = decorate(text, text.length);
	assert.deepEqual(hidden, ["**", "**", "*", "*", "~~", "~~", "`", "`"]);
	assert.deepEqual(classes, ["cm-live-strong:粗", "cm-live-emphasis:斜", "cm-live-strike:删", "cm-live-code:码"]);
});

test("reading keeps symbols hidden even when the selection touches an element", () => {
	const text = "# Heading\n\n**bold** [target](产品说明.md)\n\n- [ ] task\n\n$x^2$\n\nend";
	const reading = decorate(text, text.length, 0, LIBRARY, true);
	const away = decorate(text, text.length);
	assert.deepEqual(reading, away);
	assert(reading.hidden.includes("# "));
	assert(reading.widgets.includes("[ ]=>CheckboxWidget"));
});

test("ordinary and automatic links share library resolution and safe external addresses", () => {
	const text = "[target](产品说明.md#标题) [missing](missing.md) [local](#Heading) <https://example.com> https://example.org [unsafe](javascript:alert)\n\nend";
	const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), liveLibrary, EditorState.readOnly.of(true)] })
		.update({ effects: updateLibrary(LIBRARY) }).state;
	ensureSyntaxTree(state, state.doc.length, 5000);
	const links: Record<string, string>[] = [];
	liveDecorations(state).between(0, text.length, (_from, _to, value) => {
		if (value.spec.attributes?.class?.startsWith("cm-live-")) links.push(value.spec.attributes);
	});
	assert(links.some((link) => link["data-asset-id"] === "notes" && link["data-anchor"] === "标题"));
	assert(links.some((link) => link.class === "cm-live-broken"));
	assert(links.some((link) => link["data-anchor"] === "heading" && !link["data-asset-id"]));
	assert.deepEqual(links.flatMap((link) => link["data-href"] ? [link["data-href"]] : []), ["https://example.com", "https://example.org"]);
});

test("HTTP images render without being mistaken for missing library files", () => {
	const text = "![alt](https://example.com/image.png)\n\nend";
	const { widgets, classes } = decorate(text, text.length);
	assert(widgets.some((widget) => widget.includes("https://example.com/image.png")));
	assert.equal(classes.some((name) => name.includes("broken")), false);
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
	// Only the fence lines collapse; nothing inside the block or the escapes is read as Markdown.
	assert.deepEqual(hidden, ["```", "```"]);
	assert.deepEqual(classes, []);
});

test("decorating never changes the text", () => {
	const text = "# H\n\n**b** [l](u)\n";
	const state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage })] });
	liveDecorations(state);
	assert.equal(state.doc.toString(), text);
});


test("a wiki link shows its name, links to the asset and hides the brackets away from the cursor", () => {
	const text = "见 [[产品说明.md]] 和 [[产品/说明|  别名  ]] 与 [[产品说明#标题]]\n\n末";
	const { hidden, targets, widgets } = decorate(text, text.length);
	assert.deepEqual(hidden, ["[[", "]]", "[[", "产品/说明|  ", "  ]]", "[[", "]]"]);
	assert.deepEqual(targets, ["产品说明.md->notes", "别名->deep", "产品说明#标题->notes#标题"]);
	assert.deepEqual(widgets, ["=>FileExtensionWidget"]);
});

test("a wiki link shows its brackets while the cursor is in it", () => {
	const text = "[[产品说明]]";
	assert.deepEqual(decorate(text, 4).hidden, []);
	assert.deepEqual(decorate(text, 0).hidden, []);
	assert.deepEqual(decorate(text, text.length).hidden, []);
});

test("a wiki link to a missing file is marked broken and keeps no target", () => {
	const text = "[[待调研]] 和 [[说明]]\n\n末";
	const { classes, targets } = decorate(text, text.length);
	assert.deepEqual(classes, ["cm-live-wiki cm-live-broken:待调研", "cm-live-wiki cm-live-broken:说明"]);
	assert.deepEqual(targets, ["待调研->none", "说明->none"]);
});

test("a link to a heading of the same file is not broken", () => {
	const text = "[[#小节]] [[#]]\n\n末";
	const { classes, targets } = decorate(text, text.length);
	assert.deepEqual(classes, ["cm-live-wiki cm-live-link markdown-file-link:#小节"]);
	assert.deepEqual(targets, ["#小节->none#小节"]);
});

test("wiki embeds stay rendered at the caret, and standard Markdown images still reveal their source", () => {
	const text = "![[图/架构图.png]] ![](图/架构图.png)\n\n末";
	const away = decorate(text, text.length);
	assert.equal(away.widgets.length, 2);
	assert.equal(away.widgets[0], "![[图/架构图.png]]=>asset:pic");
	assert.match(away.widgets[1], /^!\[\]\(图\/架构图.png\)=>loom-asset:/);
	assert.deepEqual(decorate(text, 4).widgets, away.widgets);
	assert.deepEqual(decorate(text, text.indexOf("![]") + 4).widgets, [away.widgets[0]]);
});

test("a missing embedded picture is marked broken", () => {
	const text = "![[没有.png]] ![](gone.png)\n\n末";
	const { widgets, classes } = decorate(text, text.length);
	assert.deepEqual(widgets, []);
	assert.deepEqual(classes, ["cm-live-broken:![[没有.png]]", "cm-live-broken:![](gone.png)"]);
});

test("wiki syntax in code, escapes and addresses is left alone", () => {
	const text = "`[[产品说明]]` \\[\\[产品说明\\]\\] [x]([[产品说明]])\n\n```\n[[产品说明]]\n```\n\n末";
	const { hidden, classes, targets } = decorate(text, text.length);
	// The outer ordinary link is unresolved; its address does not become a wiki reference.
	assert.deepEqual(targets, ["x->none"]);
	assert.equal(classes.some((entry) => entry.includes("wiki")), false);
	assert.equal(hidden.includes("[["), false);
});

test("without a library nothing is resolved or flagged", () => {
	const text = "[[产品说明]] ![[a.png]]\n\n末";
	const { hidden, classes, widgets } = decorate(text, text.length, text.length, null as never);
	assert.deepEqual([hidden, classes, widgets], [[], [], []]);
});

test("the editor and the preview agree on which wiki links resolve", async () => {
	const { renderMarkdown } = await import("../src/renderer/workbench/preview/markdown.ts");
	const text = "[[产品说明]] [[产品/说明]] [[说明]] [[待调研]] [[产品说明#标题]] ![[图/架构图.png]] ![[没有.png]] [[#小节]]\n\n末";
	const html = renderMarkdown(text, { fromRelativePath: "脚本.md", assets: [...LIBRARY.assets] });
	const previewBroken = html.match(/markdown-broken-reference/g)?.length ?? 0;
	const { classes, widgets } = decorate(text, text.length);
	const editorBroken = classes.filter((entry) => entry.includes("broken")).length;
	const previewResolved = [...html.matchAll(/data-asset-id="([^"]+)"|src="loom-asset:\/\/asset\/([^?"]+)/g)].map((m) => m[1] ?? m[2]);
	const editorResolved = [...decorate(text, text.length).targets.map((t) => t.split("->")[1].split("#")[0]).filter((id) => id !== "none"),
		...widgets.filter((entry) => entry.includes("=>asset:")).map((entry) => entry.split("=>asset:")[1])];
	assert.equal(editorBroken, previewBroken);
	assert.deepEqual([...new Set(editorResolved)].sort(), [...new Set(previewResolved)].sort());
});


test("list markers become bullets and checkboxes away from the cursor", () => {
	const text = "- 一\n  - 二\n* 三\n- [ ] 待办\n- [x] 完成\n1. 有序\n\n末";
	const away = decorate(text, text.length);
	assert.deepEqual(away.widgets, [
		"-=>BulletWidget", "-=>BulletWidget", "*=>BulletWidget", "[ ]=>CheckboxWidget", "[x]=>CheckboxWidget",
	]);
	assert.deepEqual(away.hidden, ["- ", "- "]);
	assert.deepEqual(away.lines, ["cm-live-task@4", "cm-live-task cm-live-task-done@5"]);
	// Ordered lists keep their numbers.
	assert.equal(away.hidden.some((entry) => entry.startsWith("1.")), false);
});

test("a list line shows its own text while the cursor is on it", () => {
	const text = "- 一\n- [ ] 待办\n\n末";
	const on = decorate(text, text.indexOf("待办"));
	assert.deepEqual(on.widgets, ["-=>BulletWidget"]);
	assert.deepEqual(on.hidden, []);
});

test("quotes hide the > marks, one bar per level, until the cursor is on the line", () => {
	const text = "> 一\n> > 二\n\n末";
	const away = decorate(text, text.length);
	assert.deepEqual(away.hidden, ["> ", "> ", "> "]);
	assert.deepEqual(away.lines, ["cm-live-quote@1", "cm-live-quote@2"]);
	assert.deepEqual(decorate(text, 1).hidden, ["> ", "> "]);
});

test("a horizontal rule becomes a line away from the cursor and shows its dashes on it", () => {
	const text = "上\n\n---\n\n***\n\n末";
	assert.deepEqual(decorate(text, text.length).widgets, ["---=>RuleWidget", "***=>RuleWidget"]);
	assert.deepEqual(decorate(text, text.indexOf("---") + 1).widgets, ["***=>RuleWidget"]);
});

test("a table row of dashes or a setext underline is not taken for a rule", () => {
	const text = "标题\n---\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n末";
	assert.deepEqual(decorate(text, text.length).widgets, []);
});


test("a fenced block gets a code background on every line and collapses its fence lines away from the cursor", () => {
	const text = "```ts\nlet a = 1;\nlet b = 2;\n```\n\n末";
	const away = decorate(text, text.length);
	assert.deepEqual(away.lines, [
		"cm-live-codeblock cm-live-codeblock-first cm-live-fence@1",
		"cm-live-codeblock@2",
		"cm-live-codeblock@3",
		"cm-live-codeblock cm-live-codeblock-last cm-live-fence@4",
	]);
	assert.deepEqual(away.hidden, ["```ts", "```"]);
	const inside = decorate(text, text.indexOf("let b"));
	assert.deepEqual(inside.hidden, []);
	assert.equal(inside.lines.some((entry) => entry.includes("cm-live-fence")), false);
});

test("an unclosed fence collapses only its opening line, and the cursor inside it brings the line back", () => {
	const text = "前文\n\n```\n未闭合";
	assert.deepEqual(decorate(text, 0).hidden, ["```"]);
	assert.deepEqual(decorate(text, text.length).hidden, []);
});

test("an indented code block is styled as code", () => {
	assert.deepEqual(decorate("    缩进\n\n末").lines, ["cm-live-codeblock@1"]);
});

test("inline formulas are drawn by KaTeX away from the cursor and show their source on it", () => {
	const text = "能量 $E=mc^2$ 与 \\(a+b\\) 和 $$x$$ 行内\n\n末";
	assert.deepEqual(decorate(text, text.length).widgets, ["$E=mc^2$=>MathWidget", "\\(a+b\\)=>MathWidget", "$$x$$=>MathWidget"]);
	const inside = decorate(text, text.indexOf("mc"));
	assert.deepEqual(inside.widgets, ["\\(a+b\\)=>MathWidget", "$$x$$=>MathWidget"]);
	assert.deepEqual(inside.classes, ["cm-live-math-source:$E=mc^2$"]);
});

test("a dollar sign that does not open a formula is left alone", () => {
	const text = "价格 $5 到 $10\n\n行内代码 `$x$`\n\n转义 \\$y\\$\n\n末";
	assert.deepEqual(decorate(text, text.length).widgets, []);
});

test("a formula on its own lines is drawn as a block and not twice", () => {
	const text = "上\n\n$$\na^2 + b^2\n$$\n\n末";
	assert.deepEqual(blocks(text), ["$$\na^2 + b^2\n$$=>MathWidget"]);
	assert.deepEqual(decorate(text, text.length).widgets, []);
	assert.deepEqual(blocks(text, text.indexOf("a^2")), []);
	assert.deepEqual(blocks("\\[x\\]\n\n末"), ["\\[x\\]=>MathWidget"]);
});

test("a mermaid fence is drawn as a diagram away from the cursor, other fences are not", () => {
	const text = "```mermaid\ngraph TD; A-->B\n```\n\n```ts\nlet a;\n```\n\n末";
	assert.deepEqual(blocks(text), ["```mermaid\ngraph TD; A-->B\n```=>MermaidWidget"]);
	assert.deepEqual(blocks(text, 14), []);
});

test("the editor and the preview agree on which formulas are formulas", async () => {
	const { renderMarkdown } = await import("../src/renderer/workbench/preview/markdown.ts");
	const samples = [
		"$E=mc^2$", "价格 $5 到 $10", "$$x$$", "\\(a+b\\)", "`$x$`", "\\$y\\$", "$ a $", "a$b$c", "3$x$", "$x$4",
		"$$\na\n$$", "\\[\nb\n\\]", "```\n$x$\n```", "$x\\$", "$$", "$",
	];
	for (const sample of samples) {
		const text = `${sample}\n\n末`;
		const html = renderMarkdown(text, { fromRelativePath: "a.md", assets: [] });
		const preview = (html.match(/class="katex"/g) ?? []).length;
		const editor = decorate(text, text.length).widgets.filter((entry) => entry.endsWith("MathWidget")).length + blocks(text).filter((entry) => entry.endsWith("MathWidget")).length;
		assert.equal(editor, preview, `${JSON.stringify(sample)}: editor drew ${editor}, preview ${preview}`);
	}
});

/** The selection that results from asking for `anchor`..`head` in a document with a drawn table. */
function selectOver(text: string, anchor: number, head: number): [number, number] {
	let state = EditorState.create({ doc: text, extensions: [markdown({ base: markdownLanguage }), liveDrag, liveBlocks] });
	ensureSyntaxTree(state, state.doc.length, 5000);
	// The block field is built from the tree, which is only complete now.
	state = state.update({ changes: { from: 0, insert: "" } }).state;
	state = state.update({ selection: EditorSelection.single(anchor, head) }).state;
	const range = state.selection.main;
	return [range.anchor, range.head];
}

test("a selection that ends inside a drawn table takes the whole table", () => {
	const text = "上文\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n下文";
	const from = text.indexOf("| a");
	const to = text.indexOf("\n\n下文");
	const inside = text.indexOf("| 1");
	// From the text above into the middle of the table: the end moves to the end of the table.
	assert.deepEqual(selectOver(text, 1, inside + 3), [1, to]);
	// The same backwards.
	assert.deepEqual(selectOver(text, inside + 3, 1), [to, 1]);
	// From the text below into the table: the start moves to the start of the table.
	assert.deepEqual(selectOver(text, text.length - 1, inside), [text.length - 1, from]);
	// An end on the very first position of the table is the table's edge, and the table goes in whole.
	assert.deepEqual(selectOver(text, 1, from), [1, to]);
	// From the end of the table down into the text below: the start is the table's end, so the table is not in it.
	assert.deepEqual(selectOver(text, to, text.length - 1), [to, text.length - 1]);
	// The blank line before the table is the text above it, not the table.
	assert.deepEqual(selectOver(text, 1, from - 1), [1, from - 1]);
	// A selection that already holds the table, and one that stays in the text, are left alone.
	assert.deepEqual(selectOver(text, 0, text.length), [0, text.length]);
	assert.deepEqual(selectOver(text, 0, 2), [0, 2]);
	// A caret has nothing to take in.
	assert.deepEqual(selectOver(text, inside, inside), [inside, inside]);
});

/** The selection `anchor`..`head` after it is let go, in a document whose symbols are hidden. */
function letGo(text: string, anchor: number, head: number): [number, number] {
	let state = EditorState.create({ doc: text, selection: EditorSelection.single(anchor, head), extensions: [markdown({ base: markdownLanguage }), liveDrag, liveLibrary] });
	ensureSyntaxTree(state, state.doc.length, 5000);
	// Focused, as it is while the mouse is used.
	state = state.update({ effects: setFocused.of(true) }).state;
	const moved = snapToSymbols(state);
	const range = (moved ?? state.selection).main;
	return [range.anchor, range.head];
}

test("a selection let go at the edge of a hidden symbol takes the symbols that belong to what it holds", () => {
	const text = "前 **粗体** 后";
	const open = text.indexOf("**");
	const body = open + 2;
	const end = text.indexOf("体") + 1;
	const close = end + 2;
	// Starting at the first letter of the bold text, the opening `**` is in; ending after the last, the closing is in.
	assert.deepEqual(letGo(text, body, text.length), [open, text.length]);
	assert.deepEqual(letGo(text, 0, end), [0, close]);
	assert.deepEqual(letGo(text, body, end), [open, close]);
	// Starting inside the closing symbols leaves them out, and ending inside the opening ones leaves them out.
	assert.deepEqual(letGo(text, end, text.length), [close, text.length]);
	assert.deepEqual(letGo(text, 0, body), [0, open]);
	// Backwards is the same selection.
	assert.deepEqual(letGo(text, close, 0), [close, 0]);
	assert.deepEqual(letGo(text, end, body), [close, open]);
	// Edges in the middle of the text, or in text with no symbols, stay.
	assert.deepEqual(letGo(text, body + 1, end - 1), [body + 1, end - 1]);
	assert.deepEqual(letGo(text, 0, 1), [0, 1]);
});

test("a heading's hashes, a link's brackets and a quote's bar go with the text a selection starts at", () => {
	const heading = "# 标题\n\n正文";
	assert.deepEqual(letGo(heading, 2, heading.length), [0, heading.length]);
	assert.deepEqual(letGo(heading, 0, 4), [0, 4]);
	const link = "看 [文字](https://example.com) 吧";
	const textStart = link.indexOf("文");
	const urlEnd = link.indexOf(")") + 1;
	assert.deepEqual(letGo(link, textStart, link.length), [link.indexOf("["), link.length]);
	assert.deepEqual(letGo(link, 0, textStart + 2), [0, urlEnd]);
	assert.deepEqual(letGo(link, urlEnd, link.length), [urlEnd, link.length]);
	const quote = "> 引用\n\n正文";
	assert.deepEqual(letGo(quote, 2, quote.length), [0, quote.length]);
});

test("a caret and a selection with the symbols shown are left alone", () => {
	const text = "前 **粗体** 后";
	assert.deepEqual(letGo(text, 5, 5), [5, 5]);
	// A selection of nothing but one symbol stays as it is.
	assert.deepEqual(letGo(text, 2, 4), [2, 4]);
});
