import { pickedCompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { matchWikiLink, resolveWikiTarget } from "@loom/core/references";
import { insideLiteral, liveLibrary, type LiveLibrary } from "./live-markdown.ts";

const targetText = /^[^[\]#|\r\n]*$/;
const remainingLink = /^([^[\]#|]*)(?:[#|][^[\]]*)?\]\]/;
const libraryOptions = new WeakMap<LiveLibrary, { links: Completion[]; images: Completion[] }>();

export function wikiTargetAt(state: EditorState, position: number): { from: number; embed: boolean; canOpenOnMove: boolean } | null {
	if (state.readOnly || !state.selection.main.empty) return null;
	const line = state.doc.lineAt(position);
	const before = line.text.slice(0, position - line.from);
	const open = before.lastIndexOf("[[");
	if (open < 0 || !targetText.test(before.slice(open + 2))) return null;
	const embed = before[open - 1] === "!";
	const linkStart = open - Number(embed);
	if (insideLiteral(syntaxTree(state), line.from + linkStart, position)) return null;
	const from = line.from + open + 2;
	return {
		from,
		embed,
		canOpenOnMove: from === position && !matchWikiLink(line.text, linkStart)?.target,
	};
}

function insertReference(view: EditorView, completion: Completion, from: number, to: number): void {
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
	const target = wikiTargetAt(context.state, context.pos);
	const library = context.state.field(liveLibrary, false);
	if (!target || !library) return null;
	let options = libraryOptions.get(library);
	if (!options) {
		options = { links: [], images: [] };
		for (const { assetId, relativePath, type } of library.assets) {
			if (relativePath === library.fromRelativePath || !targetText.test(relativePath)) continue;
			if (resolveWikiTarget(relativePath, library.lookup)?.assetId !== assetId) continue;
			const completion: Completion = {
				label: relativePath,
				apply(view, completion, from, to) {
					const active = wikiTargetAt(view.state, to);
					if (active?.from !== from) return;
					const current = view.state.field(liveLibrary, false);
					const asset = current && resolveWikiTarget(relativePath, current.lookup);
					if (asset?.assetId === assetId && (!active.embed || asset.type === "image")) {
						insertReference(view, completion, from, to);
					}
				},
			};
			options.links.push(completion);
			if (type === "image") options.images.push(completion);
		}
		libraryOptions.set(library, options);
	}
	return {
		from: target.from,
		options: target.embed ? options.images : options.links,
		validFor: (_text, start, end, state) => {
			if (state.field(liveLibrary, false) !== library) return false;
			const active = wikiTargetAt(state, end);
			return active?.from === start && active.embed === target.embed;
		},
	};
};
