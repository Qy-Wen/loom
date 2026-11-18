import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** What the editor says about itself to the component that owns it. */
export interface MarkdownEditorEvents {
	/** The text changed because of the user, not because the owner replaced it. */
	onChange(text: string): void;
	onBlur(): void;
	onSave(): void;
}

/** Colors come from the app's design tokens, so the editor follows the theme with no extra work. */
const theme = EditorView.theme({
	"&": {
		height: "100%",
		color: "var(--lm-text-body)",
		backgroundColor: "var(--lm-surface-app)",
		fontSize: "13px",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": { fontFamily: "var(--lm-font-mono)", lineHeight: "1.65", padding: "18px 0" },
	".cm-content": { padding: "0 26px", caretColor: "var(--lm-text-primary)" },
	".cm-line": { padding: 0 },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lm-text-primary)" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "var(--lm-surface-active)",
	},
	".cm-panels": {
		color: "var(--lm-text-body)",
		backgroundColor: "var(--lm-surface-raised)",
		borderColor: "var(--lm-border-default)",
		fontFamily: "var(--lm-font-sans)",
	},
	".cm-panels-bottom": { borderTop: "1px solid var(--lm-border-default)" },
	".cm-panel.cm-search": { padding: "6px 28px 6px 10px", fontSize: "12px" },
	".cm-panel.cm-search input, .cm-panel.cm-search button": { font: "inherit", color: "inherit" },
	".cm-panel.cm-search input": {
		border: "1px solid var(--lm-border-default)",
		borderRadius: "var(--lm-radius-sm)",
		backgroundColor: "var(--lm-surface-app)",
	},
	".cm-panel.cm-search button": {
		border: "1px solid var(--lm-border-default)",
		borderRadius: "var(--lm-radius-sm)",
		backgroundColor: "var(--lm-surface-app)",
		backgroundImage: "none",
		cursor: "pointer",
	},
	".cm-panel.cm-search [name=close]": { color: "var(--lm-text-muted)", border: "none", backgroundColor: "transparent" },
	".cm-searchMatch": { backgroundColor: "var(--lm-surface-hover)", outline: "1px solid var(--lm-border-strong)" },
	".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--lm-surface-active)" },
});

/** Markdown syntax shown as plain colored text for now. Live rendering replaces most of this. */
const highlight = HighlightStyle.define([
	{ tag: tags.heading, fontWeight: "var(--lm-weight-semibold)", color: "var(--lm-text-primary)" },
	{ tag: tags.strong, fontWeight: "var(--lm-weight-semibold)" },
	{ tag: tags.emphasis, fontStyle: "italic" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{ tag: [tags.link, tags.url], color: "var(--lm-text-accent)" },
	{ tag: [tags.monospace, tags.quote], color: "var(--lm-text-secondary)" },
	{ tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: "var(--lm-text-muted)" },
]);

export interface MarkdownEditor {
	view: EditorView;
	/** Replace the whole text without reporting it as a user edit. */
	setText(text: string): void;
	focus(): void;
	destroy(): void;
}

export function createMarkdownEditor(parent: HTMLElement, text: string, events: MarkdownEditorEvents, label: string): MarkdownEditor {
	let replacing = false;
	const extensions: Extension[] = [
		history(),
		drawSelection(),
		EditorView.lineWrapping,
		markdown({ base: markdownLanguage }),
		syntaxHighlighting(highlight),
		search({ top: false }),
		theme,
		EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
		keymap.of([
			{ key: "Mod-s", preventDefault: true, run: () => { events.onSave(); return true; } },
			indentWithTab,
			...searchKeymap,
			...historyKeymap,
			...defaultKeymap,
		]),
		EditorView.updateListener.of((update) => {
			if (update.docChanged && !replacing) events.onChange(update.state.doc.toString());
		}),
		EditorView.domEventHandlers({ blur: () => { events.onBlur(); } }),
	];
	const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions }) });
	return {
		view,
		setText(next) {
			if (view.state.doc.toString() === next) return;
			replacing = true;
			try {
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
			} finally {
				replacing = false;
			}
		},
		focus: () => view.focus(),
		destroy: () => view.destroy(),
	};
}
