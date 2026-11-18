import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Asset } from "@loom/core";
import { liveDecorations, liveLibrary, updateLibrary } from "../src/renderer/workbench/preview/live-markdown.ts";

const asset = (assetId: string, relativePath: string): Asset => ({
	assetId, relativePath, filename: relativePath.split("/").pop()!, type: relativePath.endsWith(".png") ? "image" : "text",
	size: 1, createdAt: 1, modifiedAt: 2,
});
const LIBRARY = {
	fromRelativePath: "脚本.md",
	assets: [asset("notes", "产品说明.md"), asset("deep", "产品/说明.md"), asset("pic", "图/架构图.png"), asset("self", "脚本.md")],
};

/** The decorations of `text` with the cursor at `cursor` (end of the text by default), as plain facts. */
function decorate(text: string, cursor = text.length, anchor = cursor, library = LIBRARY) {
	let state = EditorState.create({
		doc: text,
		selection: EditorSelection.single(anchor, cursor),
		extensions: [markdown({ base: markdownLanguage }), liveLibrary],
	});
	if (library) state = state.update({ effects: updateLibrary(library) }).state;
	ensureSyntaxTree(state, state.doc.length, 5000);
	const hidden: string[] = [];
	const classes: string[] = [];
	const lines: string[] = [];
	const widgets: string[] = [];
	const targets: string[] = [];
	liveDecorations(state).between(0, state.doc.length, (from, to, value) => {
		const spec = value.spec as { class?: string; widget?: { src?: string }; attributes?: Record<string, string> };
		const name = spec.class ?? spec.attributes?.class ?? "";
		if (spec.widget) widgets.push(`${text.slice(from, to)}=>${spec.widget.src ?? spec.widget.constructor.name}`);
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


test("a wiki link shows its name, links to the asset and hides the brackets away from the cursor", () => {
	const text = "见 [[产品说明]] 和 [[产品/说明|别名]] 与 [[产品说明#标题]]\n\n末";
	const { hidden, targets } = decorate(text, text.length);
	assert.deepEqual(hidden, ["[[", "]]", "[[", "产品/说明|", "]]", "[[", "]]"]);
	assert.deepEqual(targets, ["产品说明->notes", "别名->deep", "产品说明#标题->notes#标题"]);
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
	assert.deepEqual(classes, ["cm-live-wiki cm-live-link:#小节"]);
	assert.deepEqual(targets, ["#小节->none#小节"]);
});

test("an embed shows the picture away from the cursor and its text under it", () => {
	const text = "![[图/架构图.png]] ![](图/架构图.png)\n\n末";
	const away = decorate(text, text.length);
	assert.equal(away.widgets.length, 2);
	assert.match(away.widgets[0], /^!\[\[图\/架构图.png\]\]=>loom-asset:\/\/asset\/pic/);
	assert.match(away.widgets[1], /^!\[\]\(图\/架构图.png\)=>loom-asset:/);
	assert.equal(decorate(text, 4).widgets.length, 1);
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
	assert.deepEqual(targets, []);
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
		...widgets.map((entry) => entry.split("/asset/")[1].split("?")[0])];
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
