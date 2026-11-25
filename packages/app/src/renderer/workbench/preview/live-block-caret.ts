import { isolateHistory } from "@codemirror/commands";
import { EditorState, MapMode, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

/** End of the blank separator when an editable line already follows it. */
export function paragraphSeparatorEnd(doc: Text, end: number): number {
	if (end >= doc.length) return end;
	const line = doc.lineAt(end + 1);
	return line.from === end + 1 && line.to < doc.length && !line.text.trim() ? line.to : end;
}

const foldSeparatorAfter = StateEffect.define<number>();
const foldedSeparator = Decoration.replace({ block: true });
const atomicSeparator = Decoration.mark({});

export const continuedBlockSeparator = StateField.define<number | null>({
	create: () => null,
	update(end, transaction) {
		for (const effect of transaction.effects) if (effect.is(foldSeparatorAfter)) return effect.value;
		if (end === null || !transaction.docChanged) return end;
		return transaction.changes.mapPos(end, -1, MapMode.TrackBefore);
	},
	provide: (field) => [
		EditorView.decorations.compute([field, "doc", EditorState.readOnly], (state) => {
			const end = state.field(field);
			if (end === null || state.readOnly) return Decoration.none;
			const separatorEnd = paragraphSeparatorEnd(state.doc, end);
			return separatorEnd > end ? Decoration.set(foldedSeparator.range(end + 1, separatorEnd)) : Decoration.none;
		}),
		EditorView.atomicRanges.of(({ state }) => {
			const end = state.field(field);
			if (end === null || state.readOnly) return Decoration.none;
			const separatorEnd = paragraphSeparatorEnd(state.doc, end);
			// Backspace from the empty final line removes both line breaks without deleting the block.
			return separatorEnd > end && separatorEnd + 1 === state.doc.length
				? Decoration.set(atomicSeparator.range(end, state.doc.length)) : Decoration.none;
		}),
	],
});

export function focusAfterBlock(view: EditorView, end: number, anchor: number, foldSeparator: boolean): void {
	const { doc } = view.state;
	const effects = foldSeparator ? foldSeparatorAfter.of(end) : undefined;
	const following = end < doc.length ? doc.lineAt(end + 1) : null;
	if (!following || (following.number === doc.lines && !following.text.trim())) {
		// Leave a blank separator so the text typed after the widget starts a new paragraph.
		const insert = following ? "\n" : "\n\n";
		view.dispatch({
			changes: { from: doc.length, insert },
			selection: { anchor: doc.length + insert.length },
			effects,
			annotations: isolateHistory.of("full"),
			userEvent: "input",
			scrollIntoView: true,
		});
	} else {
		view.dispatch({ selection: { anchor }, effects, scrollIntoView: true });
	}
	view.focus();
}
