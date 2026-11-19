import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { EditorState } from "@codemirror/state";
import { markdownHeadingKey } from "./markdown.ts";

/** Both heading styles use the same visible-text key as the HTML renderer. */
export function editorHeading(state: EditorState, node: { name: string; from: number; to: number }): { level: number; key: string } | null {
	const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
	if (!match) return null;
	let text = state.doc.sliceString(node.from, node.to);
	if (node.name.startsWith("ATX")) text = text.replace(/^#{1,6}\s*/, "").replace(/\s+#+\s*$/, "");
	else text = text.replace(/\n[ \t]*[=-]+[ \t]*$/, "");
	return { level: Number(match[1]), key: markdownHeadingKey(text) };
}

/** A heading may be outside CodeMirror's parsed viewport. A jump must search the whole document, not the DOM. */
export function findEditorHeading(state: EditorState, anchor: string): number | null {
	const tree = syntaxTree(state).length === state.doc.length ? syntaxTree(state)
		: ensureSyntaxTree(state, state.doc.length, 1000) ?? markdownLanguage.parser.parse(state.doc.toString());
	let found: number | null = null;
	tree.iterate({ enter(node) {
		if (found !== null) return false;
		const heading = editorHeading(state, node);
		if (heading?.key === anchor) found = node.from;
	} });
	return found;
}
