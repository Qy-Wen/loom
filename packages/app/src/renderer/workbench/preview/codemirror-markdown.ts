import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, redo, redoDepth, selectAll, undo, undoDepth } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, panels } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { liveBlockKeys, liveBlocks, liveClicks, liveDrag, liveHandlers, liveLibrary, liveMarkdown, liveMarkdownTheme, liveTables, setFocused, updateLibrary, type LiveHandlers, type LiveLibrary } from "./live-markdown.ts";
import { leaveCell, type TableHooks } from "./live-table.ts";
import { findEditorHeading } from "./editor-heading.ts";
import { MarkdownFindPanel, type MarkdownFindLabels } from "./markdown-find.ts";
import { markdownFindWidgets, searchSelection } from "./markdown-find-widgets.ts";
import { markdownFormatPlans } from "./markdown-format.ts";
import { markdownInsert, openMarkdownInsert } from "./markdown-insert.ts";
import { isImeComposing } from "../../components/ime-composition.ts";
import type { EditorClipboardAction, MarkdownContextAction, MarkdownContextState, UiSelectionDraft } from "../../../shared/ipc.ts";
import type { Messages } from "../../../shared/locale.ts";

export type MarkdownMode = "edit" | "read" | "source";
const replaceText = Annotation.define<boolean>();

/** What the editor says about itself to the component that owns it. */
export interface MarkdownEditorEvents {
	/** The text changed because of the user, not because the owner replaced it. */
	onChange(text: string): void;
	onBlur(): void;
	onSave(): void;
	onFindOpenChange(open: boolean): void;
	/** A link was opened. An empty target means a heading in this file. */
	onOpenAsset(assetId: string, anchor: string | undefined): void;
}

/** Table labels and the search panel's localized phrases. */
export interface MarkdownEditorLabels {
	addRow: string;
	addColumn: string;
	moveRow: string;
	moveColumn: string;
	searchPhrases: Record<string, string>;
	find: MarkdownFindLabels;
	insertCommands: Messages["preview"]["insertCommands"];
}

/** What the editor asks the window for. */
export interface MarkdownEditorHost {
	chooseTableAction: TableHooks["chooseAction"];
	chooseTextAction(state: MarkdownContextState): Promise<MarkdownContextAction | null>;
	clipboard(action: EditorClipboardAction): Promise<void>;
	pickAssets(): Promise<UiSelectionDraft[]>;
}

/** Colors come from the app's design tokens, so the editor follows the theme with no extra work. */
const theme = EditorView.theme({
	"&": {
		height: "100%",
		color: "var(--lm-text-body)",
		backgroundColor: "var(--lm-surface-raised)",
		fontSize: "15px",
		"--markdown-selection-bg": "color-mix(in srgb, var(--lm-text-accent) 25%, var(--lm-surface-raised))",
	},
	"&.cm-focused": { outline: "none" },
	// The side gutter belongs to the scroller, not the content: a selection is drawn out to the content box's edges
	// less the line's padding, so padding on the content would put the highlight that far outside the text.
	".cm-scroller": { fontFamily: '"Segoe UI", system-ui, sans-serif', lineHeight: "1.65", padding: "28px 32px 64px" },
	".cm-content": { maxWidth: "656px", margin: "0 auto", padding: "0", caretColor: "var(--lm-text-primary)" },
	".cm-line": { padding: 0 },
	"&.cm-markdown-source .cm-scroller": { fontFamily: "var(--lm-font-mono)" },
	"&.cm-markdown-read .cm-content": { caretColor: "transparent" },
	// Hide the layer, not individual cursors: CodeMirror's focused-cursor rule has higher specificity.
	"&.cm-markdown-read .cm-cursorLayer": { display: "none" },
	"&.cm-markdown-read .cm-live-checkbox": { cursor: "default" },
	"&.cm-markdown-read .cm-live-wiki, &.cm-markdown-read [data-asset-id], &.cm-markdown-read [data-anchor], &.cm-markdown-read [data-href]": { cursor: "pointer" },
	"&.cm-markdown-read .cm-live-math, &.cm-markdown-read .cm-live-mermaid": { cursor: "default" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lm-text-primary)" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
		backgroundColor: "var(--markdown-selection-bg)",
	},
	".cm-panels": {
		color: "var(--lm-text-body)",
		backgroundColor: "var(--lm-surface-raised)",
		borderColor: "var(--lm-border-default)",
		fontFamily: "var(--lm-font-sans)",
	},
	".cm-panels-bottom": { borderTop: "1px solid var(--lm-border-default)" },
	".cm-panels-top": { borderBottom: "1px solid var(--lm-border-default)" },
	".cm-searchMatch .cm-live-code": { backgroundColor: "transparent" },
	".cm-searchMatch, .cm-content .cm-live-find-match": {
		backgroundColor: "var(--lm-surface-warning)",
		borderRadius: "var(--lm-radius-line)",
	},
	".cm-searchMatch.cm-searchMatch-selected, .cm-content .cm-live-find-match.cm-live-find-current": {
		backgroundColor: "color-mix(in srgb, var(--lm-warning) 38%, var(--lm-surface-raised))",
		outline: "1px solid var(--lm-warning)",
	},
	".cm-live-find-current": {
		outlineOffset: "-1px",
	},
});

/**
 * Colors for what live rendering leaves visible as syntax: the symbols of the element under the cursor,
 * addresses, quote and list markers. The look of rendered text comes from `live-markdown.ts`.
 */
const highlight = HighlightStyle.define([
	{ tag: [tags.url, tags.link], color: "var(--lm-text-secondary)" },
	{ tag: tags.quote, color: "var(--lm-text-secondary)" },
	{ tag: [tags.processingInstruction, tags.contentSeparator, tags.meta], color: "var(--lm-text-muted)" },
]);

export interface MarkdownEditor {
	view: EditorView;
	/** Tell the editor which library its references are checked against. */
	setLibrary(library: LiveLibrary): void;
	setLabel(label: string): void;
	/** Replace the whole text without reporting it as a user edit. */
	setText(text: string): void;
	/** Switch in place, preserving the document, history, selection and scroll position. */
	setMode(mode: MarkdownMode): void;
	find(): void;
	insert(): void;
	scrollToHeading(anchor: string): void;
	focus(): void;
	destroy(): void;
}

export function createMarkdownEditor(parent: HTMLElement, findContainer: HTMLElement, text: string, events: MarkdownEditorEvents, label: string, library: LiveLibrary, labels: MarkdownEditorLabels, host: MarkdownEditorHost, initialMode: MarkdownMode = "edit"): MarkdownEditor {
	let replacing = false;
	let mode = initialMode;
	const rendering = new Compartment();
	const access = new Compartment();
	const accessible = new Compartment();
	const rendered: Extension = [liveDrag, liveMarkdown, liveBlocks, liveBlockKeys, liveMarkdownTheme, liveClicks];
	const modeAccess = (next: MarkdownMode): Extension => [
		EditorState.readOnly.of(next === "read"),
		EditorView.editable.of(next !== "read"),
		EditorView.contentAttributes.of({ "aria-readonly": String(next === "read"), tabindex: "0" }),
		EditorView.editorAttributes.of({ class: `cm-markdown-${next}` }),
	];
	// The tables call back into the editor they are drawn in, which does not exist until the extensions are built.
	let view: EditorView;
	const extensions: Extension[] = [
		history(),
		// No caret at the end of a selection: next to a drawn table it is as tall as the table.
		drawSelection({ drawRangeCursor: false }),
		EditorView.lineWrapping,
		markdown({ base: markdownLanguage }),
		syntaxHighlighting(highlight),
		liveLibrary,
		liveHandlers({ openAsset: events.onOpenAsset } satisfies LiveHandlers),
		liveTables({
			openAsset: events.onOpenAsset,
			save: events.onSave,
			chooseAction: host.chooseTableAction,
			clipboard: host.clipboard,
			labels,
		}),
		rendering.of(mode === "source" ? [] : rendered),
		access.of(modeAccess(mode)),
		// readOnly protects commands; this also protects widget and clipboard transactions. External reloads are allowed.
		EditorState.transactionFilter.of((transaction) => transaction.docChanged && transaction.startState.readOnly && !transaction.annotation(replaceText) ? [] : transaction),
		search({ createPanel: (editor) => new MarkdownFindPanel(editor, labels.find) }),
		searchSelection,
		markdownFindWidgets,
		panels({ topContainer: findContainer }),
		markdownInsert(labels.insertCommands, host.pickAssets),
		EditorState.phrases.of(labels.searchPhrases),
		theme,
		accessible.of(EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" })),
		keymap.of([
			{ key: "Mod-s", preventDefault: true, run: () => { events.onSave(); return true; } },
			indentWithTab,
			...searchKeymap,
			...historyKeymap,
			...defaultKeymap,
		]),
		EditorView.updateListener.of((update) => {
			if (update.docChanged && !replacing) events.onChange(update.state.doc.toString());
			const findOpen = searchPanelOpen(update.state);
			if (findOpen !== searchPanelOpen(update.startState)) events.onFindOpenChange(findOpen);
		}),
		EditorView.domEventHandlers({
			blur: () => { events.onBlur(); },
			mousedown(event, editor) {
				if (event.button !== 2) return false;
				const position = editor.posAtCoords({ x: event.clientX, y: event.clientY });
				if (position !== null && !editor.state.selection.ranges.some((range) => position >= range.from && position <= range.to)) {
					editor.dispatch({ selection: { anchor: position } });
				}
				editor.focus();
				return true; // Keep a right click inside the selection from collapsing it in Chromium.
			},
		}),
	];
	view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions }) });
	view.contentDOM.addEventListener("keydown", (event) => {
		// Let the IME confirm its candidate before CodeMirror handles Enter as a menu selection.
		if (event.key === "Enter" && isImeComposing(event) && completionStatus(view.state)) event.stopImmediatePropagation();
	}, true);
	view.dispatch({ effects: updateLibrary(library) });
	// Listen on the outer DOM too, so rendered images/formulas can open the same menu as plain text.
	view.dom.addEventListener("contextmenu", (event) => {
		const target = event.target as HTMLElement | null;
		if (!target || !view.contentDOM.contains(target) || target.closest(".cm-live-table")) return;
		event.preventDefault();
		view.focus();
		const state = view.state;
		const plans = markdownFormatPlans(state);
		void host.chooseTextAction({
			readOnly: state.readOnly, canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0,
			canCopy: state.selection.ranges.some((range) => !range.empty || !!state.doc.lineAt(range.head).text),
			formats: Object.fromEntries([...plans].map(([format, plan]) => [format, plan.checked])),
		}).then(async (action) => {
			if (!action || !view.dom.isConnected || (view.state.readOnly && action !== "copy" && action !== "select_all")) return;
			view.focus();
			if (action === "undo") undo(view);
			else if (action === "redo") redo(view);
			else if (action === "select_all") selectAll(view);
			else if (action === "cut" || action === "copy" || action === "paste") await host.clipboard(action);
			else if (view.state.doc === state.doc && view.state.selection.eq(state.selection)) {
				const edit = plans.get(action)?.transaction();
				if (edit) view.dispatch({ ...edit, annotations: isolateHistory.of("full"), userEvent: "input.format", scrollIntoView: true });
			}
		});
	});
	return {
		view,
		setLibrary: (next) => view.dispatch({ effects: updateLibrary(next) }),
		setLabel: (next) => view.dispatch({ effects: accessible.reconfigure(EditorView.contentAttributes.of({ "aria-label": next, spellcheck: "false" })) }),
		setText(next) {
			if (view.state.doc.toString() === next) return;
			replacing = true;
			try {
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, annotations: replaceText.of(true) });
			} finally {
				replacing = false;
			}
		},
		setMode(next) {
			if (next === mode) return;
			closeCompletion(view);
			const hadCellFocus = leaveCell(view);
			const effects = [access.reconfigure(modeAccess(next))];
			if ((next === "source") !== (mode === "source")) effects.push(rendering.reconfigure(next === "source" ? [] : rendered));
			mode = next;
			view.dispatch({ effects });
			if (hadCellFocus && mode !== "read") view.focus();
			if (mode !== "source") view.dispatch({ effects: setFocused.of(view.hasFocus) });
		},
		find: () => { openSearchPanel(view); },
		insert: () => {
			leaveCell(view);
			openMarkdownInsert(view);
		},
		scrollToHeading(anchor) {
			const position = findEditorHeading(view.state, anchor);
			if (position !== null) view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start" }) });
		},
		focus: () => view.focus(),
		destroy: () => view.destroy(),
	};
}
