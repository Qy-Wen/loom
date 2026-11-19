import assert from "node:assert/strict";
import { test } from "node:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { findEditorHeading } from "../src/renderer/workbench/preview/editor-heading.ts";
import { renderMarkdown } from "../src/renderer/workbench/preview/markdown.ts";

const stateOf = (doc: string) => EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });

test("editor heading jumps use visible text, support both heading styles and ignore code", () => {
	const text = "```\n# Fake\n```\n\n# **Q&A** `总结` ###\n\nSetext *title*\n---\n\n# Q&A 总结\n";
	const state = stateOf(text);
	assert.equal(findEditorHeading(state, "fake"), null);
	assert.equal(findEditorHeading(state, "q a 总结"), text.indexOf("# **Q&A**"));
	assert.equal(findEditorHeading(state, "setext title"), text.indexOf("Setext"));
	assert.equal(findEditorHeading(state, "missing"), null);
	assert.match(renderMarkdown(text), /data-heading="q a 总结"/);
	assert.match(renderMarkdown(text), /data-heading="setext title"/);
});

test("an editor jump finds headings beyond the initial parsed viewport", () => {
	const text = "paragraph\n\n".repeat(5000) + "## Late heading\n";
	assert.equal(findEditorHeading(stateOf(text), "late heading"), text.indexOf("## Late"));
});
