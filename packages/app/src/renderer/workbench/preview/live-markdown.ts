import { syntaxTree } from "@codemirror/language";
import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Asset } from "@loom/core";
import { createAssetLookup, matchWikiLink, resolveLinkTarget, resolveWikiTarget, type AssetLookup } from "@loom/core/references";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { anchorOf } from "./heading-key.ts";

/**
 * Live rendering: Markdown shown in its final look while it is edited. The text itself never changes; only
 * how it is drawn does. The symbols of an element (`#`, `**`, the brackets of a link) are hidden until the
 * cursor or a selection touches that element, which is when they are needed to edit it.
 */

const hidden = Decoration.mark({ class: "cm-live-hidden" });

/** Where the open file is and what the library holds, so a reference can be checked against real files. */
export interface LiveLibrary {
	/** Library-relative path of the file being edited. */
	fromRelativePath: string;
	assets: readonly Asset[];
}

interface LiveContext {
	fromRelativePath: string;
	lookup: AssetLookup;
}

const setLibrary = StateEffect.define<LiveLibrary>();

/** Holds the library the editor checks references against. Replace it with {@link updateLibrary}. */
const libraryField = StateField.define<LiveContext | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setLibrary)) return { fromRelativePath: effect.value.fromRelativePath, lookup: createAssetLookup(effect.value.assets) };
		}
		return value;
	},
});

/** The transaction effect that gives the editor a new library. Dispatch it when the asset list changes. */
export const updateLibrary = (library: LiveLibrary) => setLibrary.of(library);

/** Called when a reference is activated with ⌘/Ctrl+click. */
export interface LiveHandlers {
	openAsset(assetId: string, anchor: string | undefined): void;
}
const handlersFacet = Facet.define<LiveHandlers, LiveHandlers | null>({ combine: (values) => values[0] ?? null });
export const liveHandlers = (handlers: LiveHandlers) => handlersFacet.of(handlers);

/** An embedded image shown in place of `![[picture.png]]` or `![alt](picture.png)`. */
class ImageWidget extends WidgetType {
	readonly src: string;
	readonly alt: string;
	constructor(src: string, alt: string) {
		super();
		this.src = src;
		this.alt = alt;
	}
	eq(other: ImageWidget): boolean {
		return other.src === this.src && other.alt === this.alt;
	}
	toDOM(): HTMLElement {
		const image = document.createElement("img");
		image.className = "cm-live-image";
		image.src = this.src;
		image.alt = this.alt;
		image.draggable = false;
		return image;
	}
}

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
	wikiLinks(state, from, to, found);
	markdownImages(state, from, to, found);
	const builder = new RangeSetBuilder<Decoration>();
	found.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to);
	for (const range of found) builder.add(range.from, range.to, range.value);
	return builder.finish();
}

/** Node types whose text is never read as Markdown inline syntax. */
const LITERAL = new Set(["InlineCode", "FencedCode", "CodeBlock", "CommentBlock", "HTMLBlock", "HTMLTag", "Escape", "URL", "Autolink", "LinkReference", "CodeText"]);

/**
 * Wiki links and embeds. Lezer reads `[[x]]` as an ordinary link, so they are found in the text instead,
 * skipping code, escapes and addresses. The shared matcher decides what counts as one.
 */
function wikiLinks(state: EditorState, from: number, to: number, found: Range<Decoration>[]): void {
	const context = state.field(libraryField, false);
	if (!context) return;
	const tree = syntaxTree(state);
	const first = state.doc.lineAt(from).from;
	const last = state.doc.lineAt(to).to;
	for (let at = first; at <= last; ) {
		const line = state.doc.lineAt(at);
		at = line.to + 1;
		if (!line.text.includes("[[")) continue;
		for (let offset = line.text.indexOf("[["); offset !== -1; offset = line.text.indexOf("[[", offset + 1)) {
			const start = offset > 0 && line.text[offset - 1] === "!" ? offset - 1 : offset;
			const match = matchWikiLink(line.text, start);
			if (!match) continue;
			const range = { from: line.from + match.from, to: line.from + match.end };
			if (insideLiteral(tree, range.from, range.to)) continue;
			offset = match.end - 1;
			decorateWiki(state, context, match, range, found);
		}
	}
}

function insideLiteral(tree: ReturnType<typeof syntaxTree>, from: number, to: number): boolean {
	for (let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(from, 1); node; node = node.parent) {
		if (LITERAL.has(node.name) && node.from <= from && node.to >= to) return true;
	}
	// An escaped bracket inside the range breaks the link.
	let escaped = false;
	tree.iterate({ from, to, enter(node) { if (node.name === "Escape") escaped = true; } });
	return escaped;
}

function decorateWiki(state: EditorState, context: LiveContext, match: ReturnType<typeof matchWikiLink> & object, range: { from: number; to: number }, found: Range<Decoration>[]): void {
	const asset = resolveWikiTarget(match.target, context.lookup);
	const hash = match.target.indexOf("#");
	const sameFile = hash === 0 && !!anchorOf(match.target.slice(1));
	const anchor = hash === -1 ? undefined : anchorOf(match.target.slice(hash + 1));
	if (asset === null && !sameFile) return;
	const editing = touched(state, range.from, range.to);
	const missing = asset === undefined && !sameFile;

	if (match.embed) {
		if (asset && !editing) {
			found.push(Decoration.replace({ widget: new ImageWidget(assetPreviewUrl(asset), match.label || match.target) }).range(range.from, range.to));
			return;
		}
		found.push(Decoration.mark({ class: missing ? "cm-live-broken" : "cm-live-link" }).range(range.from, range.to));
		return;
	}
	const open = range.from + 2;
	const close = range.to - 2;
	const attributes: Record<string, string> = { class: missing ? "cm-live-wiki cm-live-broken" : "cm-live-wiki cm-live-link" };
	if (asset) attributes["data-asset-id"] = asset.assetId;
	if (anchor) attributes["data-anchor"] = anchor;
	if (editing) {
		found.push(Decoration.mark({ attributes }).range(open, close));
		return;
	}
	// Away from the cursor: the display name if there is one, else the path; the brackets and the rest are hidden.
	const bar = match.label ? state.doc.sliceString(open, close).indexOf("|") : -1;
	found.push(hidden.range(range.from, open));
	if (bar !== -1) {
		found.push(hidden.range(open, open + bar + 1));
		found.push(Decoration.mark({ attributes }).range(open + bar + 1, close));
	} else {
		found.push(Decoration.mark({ attributes }).range(open, close));
	}
	found.push(hidden.range(close, range.to));
}

/** `![alt](picture.png)` with a library path shows the picture; an address that is not in the library is flagged. */
function markdownImages(state: EditorState, from: number, to: number, found: Range<Decoration>[]): void {
	const context = state.field(libraryField, false);
	if (!context) return;
	syntaxTree(state).iterate({
		from,
		to,
		enter(node) {
			if (node.name !== "Image") return;
			const url = node.node.getChild("URL");
			if (!url) return;
			const written = state.doc.sliceString(url.from, url.to);
			const asset = resolveLinkTarget(context.fromRelativePath, written, context.lookup);
			if (asset === null) return;
			if (asset && !touched(state, node.from, node.to)) {
				const alt = state.doc.sliceString(node.from + 2, state.doc.sliceString(node.from, node.to).indexOf("](") + node.from);
				found.push(Decoration.replace({ widget: new ImageWidget(assetPreviewUrl(asset), alt) }).range(node.from, node.to));
			} else if (!asset) {
				found.push(Decoration.mark({ class: "cm-live-broken" }).range(node.from, node.to));
			}
		},
	});
}

/** Decorations for the part of the document in view, rebuilt when the text, the cursor or the parse changes. */
export const liveMarkdown = ViewPlugin.fromClass(class {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)
			|| update.startState.field(libraryField, false) !== update.state.field(libraryField, false)) {
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
	".cm-live-broken": { whiteSpace: "nowrap", color: "var(--lm-text-danger)", textDecoration: "underline wavy", textUnderlineOffset: "3px" },
	".cm-live-wiki": { cursor: "text" },
	".cm-live-image": { maxWidth: "100%", maxHeight: "360px", width: "auto", height: "auto", borderRadius: "var(--lm-radius-sm)", verticalAlign: "middle" },
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

/**
 * ⌘/Ctrl+click on a link opens its file, and the heading it names. A plain click only places the cursor,
 * because the text is being edited.
 */
export const liveClicks = EditorView.domEventHandlers({
	mousedown(event, view) {
		if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
		const handlers = view.state.facet(handlersFacet);
		const link = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-asset-id]");
		if (!handlers || !link) return false;
		event.preventDefault();
		handlers.openAsset(link.dataset.assetId!, link.dataset.anchor);
		return true;
	},
});

export const liveLibrary = libraryField;
