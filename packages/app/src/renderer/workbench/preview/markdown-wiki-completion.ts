import { pickedCompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { resolveWikiTarget } from "@loom/core/references";
import { insideLiteral, liveLibrary, type LiveLibrary } from "./live-markdown.ts";

const targetText = /^[^[\]#|\r\n]*$/;
const remainingLink = /^([^[\]#|]*)(?:[#|][^[\]]*)?\]\]/;
const libraryOptions = new WeakMap<LiveLibrary, Completion[]>();

export function wikiTargetStart(state: EditorState, position: number): number | null {
	if (state.readOnly || !state.selection.main.empty) return null;
	const line = state.doc.lineAt(position);
	const before = line.text.slice(0, position - line.from);
	const open = before.lastIndexOf("[[");
	if (open < 0 || before[open - 1] === "!" || !targetText.test(before.slice(open + 2))) return null;
	if (insideLiteral(syntaxTree(state), line.from + open, position)) return null;
	return line.from + open + 2;
}

function insertReference(view: EditorView, completion: Completion, from: number, to: number): void {
	if (wikiTargetStart(view.state, to) !== from) return;
	const line = view.state.doc.lineAt(to);
	const after = line.text.slice(to - line.from);
	const link = remainingLink.exec(after);
	const end = link ? to + link[1].length : to + Number(after.startsWith("]"));
	const insert = link ? completion.label : completion.label + "]]";
	const suffixLength = link ? link[0].length - link[1].length : 0;
	view.dispatch({
		changes: { from, to: end, insert },
		selection: { anchor: from + insert.length + suffixLength },
		annotations: [pickedCompletion.of(completion), isolateHistory.of("full")],
		userEvent: "input.complete",
		scrollIntoView: true,
	});
}

export const wikiLinkCompletion: CompletionSource = (context) => {
	const from = wikiTargetStart(context.state, context.pos);
	const library = context.state.field(liveLibrary, false);
	if (from === null || !library) return null;
	let options = libraryOptions.get(library);
	if (!options) {
		options = [];
		for (const { assetId, relativePath } of library.assets) {
			if (relativePath === library.fromRelativePath || !targetText.test(relativePath)) continue;
			if (resolveWikiTarget(relativePath, library.lookup)?.assetId !== assetId) continue;
			options.push({
				label: relativePath,
				apply(view, completion, from, to) {
					const current = view.state.field(liveLibrary, false);
					if (current && resolveWikiTarget(relativePath, current.lookup)?.assetId === assetId) {
						insertReference(view, completion, from, to);
					}
				},
			});
		}
		libraryOptions.set(library, options);
	}
	return {
		from,
		options,
		validFor: (_text, start, end, state) => state.field(liveLibrary, false) === library && wikiTargetStart(state, end) === start,
	};
};
