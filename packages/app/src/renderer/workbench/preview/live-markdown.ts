import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/**
 * Live rendering: Markdown shown in its final look while it is edited. The text itself never changes; only
 * how it is drawn does. The symbols of an element (`#`, `**`, the brackets of a link) are hidden until the
 * cursor or a selection touches that element, which is when they are needed to edit it.
 */

const hidden = Decoration.mark({ class: "cm-live-hidden" });

/** Inline elements: a mark on the whole element, and the symbols hidden while the cursor is elsewhere. */
const INLINE: Record<string, { class: string; marks: readonly string[] }> = {
	StrongEmphasis: { class: "cm-live-strong", marks: ["EmphasisMark"] },
	Emphasis: { class: "cm-live-emphasis", marks: ["EmphasisMark"] },
	Strikethrough: { class: "cm-live-strike", marks: ["StrikethroughMark"] },
	InlineCode: { class: "cm-live-code", marks: ["CodeMark"] },
};

const HEADINGS: Record<string, string> = {
	ATXHeading1: "cm-live-h1",
	ATXHeading2: "cm-live-h2",
	ATXHeading3: "cm-live-h3",
	ATXHeading4: "cm-live-h4",
	ATXHeading5: "cm-live-h5",
	ATXHeading6: "cm-live-h6",
};

/** True when any selection range touches `from..to`, edges included, so a cursor next to a symbol reveals it. */
function touched(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

export function liveDecorations(state: EditorState, from = 0, to = state.doc.length): DecorationSet {
	const found: Range<Decoration>[] = [];
	const line = (position: number, className: string) => found.push(Decoration.line({ class: className }).range(state.doc.lineAt(position).from));

	syntaxTree(state).iterate({
		from,
		to,
		enter(node) {
			const heading = HEADINGS[node.name];
			if (heading) {
				for (let at = node.from; at <= node.to; ) {
					const text = state.doc.lineAt(at);
					line(text.from, heading);
					at = text.to + 1;
				}
				// The `#` marks and the one space after them.
				const mark = node.node.getChild("HeaderMark");
				if (mark && !touched(state, node.from, node.to)) {
					const end = state.doc.sliceString(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to;
					found.push(hidden.range(mark.from, end));
				}
				return;
			}
			const inline = INLINE[node.name];
			if (inline) {
				const marks = node.node.getChildren(inline.marks[0]);
				const first = marks[0];
				const last = marks[marks.length - 1];
				// An element with no closing mark yet (still being typed) is left as plain text.
				if (!first || !last || first.from === last.from) return;
				found.push(Decoration.mark({ class: inline.class }).range(first.to, last.from));
				if (!touched(state, node.from, node.to)) {
					found.push(hidden.range(first.from, first.to), hidden.range(last.from, last.to));
				}
				return;
			}
			if (node.name === "Link") {
				// `[text](url "title")`: keep the text, hide everything else once the cursor leaves.
				const marks = node.node.getChildren("LinkMark");
				const close = marks[1];
				if (!close || state.doc.sliceString(close.from, close.from + 2) !== "](") return;
				found.push(Decoration.mark({ class: "cm-live-link" }).range(marks[0].to, close.from));
				if (!touched(state, node.from, node.to)) {
					found.push(hidden.range(marks[0].from, marks[0].to), hidden.range(close.from, node.to));
				}
			}
		},
	});
	const builder = new RangeSetBuilder<Decoration>();
	found.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to);
	for (const range of found) builder.add(range.from, range.to, range.value);
	return builder.finish();
}

/** Decorations for the part of the document in view, rebuilt when the text, the cursor or the parse changes. */
export const liveMarkdown = ViewPlugin.fromClass(class {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
			this.decorations = this.build(update.view);
		}
	}

	build(view: EditorView): DecorationSet {
		const { from, to } = view.viewport;
		return liveDecorations(view.state, from, to);
	}
}, { decorations: (plugin) => plugin.decorations });

export const liveMarkdownTheme = EditorView.theme({
	".cm-live-hidden": { display: "none" },
	".cm-live-strong": { fontWeight: "var(--lm-weight-semibold)" },
	".cm-live-emphasis": { fontStyle: "italic" },
	".cm-live-strike": { textDecoration: "line-through" },
	".cm-live-code": {
		padding: "0.1em 0.35em",
		borderRadius: "var(--lm-radius-sm)",
		backgroundColor: "var(--lm-surface-hover)",
		fontFamily: "var(--lm-font-mono)",
		fontSize: "0.86em",
	},
	".cm-live-link": { color: "var(--lm-text-accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
	".cm-live-h1, .cm-live-h2, .cm-live-h3, .cm-live-h4, .cm-live-h5, .cm-live-h6": {
		fontWeight: "var(--lm-weight-semibold)",
		lineHeight: "1.3",
	},
	".cm-live-h1": { fontSize: "1.7em" },
	".cm-live-h2": { fontSize: "1.35em" },
	".cm-live-h3": { fontSize: "1.15em" },
	".cm-live-h4, .cm-live-h5, .cm-live-h6": { fontSize: "1em" },
});
