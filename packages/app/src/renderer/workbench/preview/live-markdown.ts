import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Facet, RangeSetBuilder, StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Asset } from "@loom/core";
import { isMarkdownFile } from "../../../shared/markdown-file.ts";
import { createAssetLookup, matchWikiLink, resolveLinkTarget, resolveWikiTarget, type AssetLookup } from "@loom/core/references";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { anchorOf } from "./heading-key.ts";
import { matchBlockMath, matchInlineMath, renderMath } from "./math.ts";
import { searchSelection } from "./markdown-find-widgets.ts";
import { liveReferenceSelectors, pressedReference } from "./live-reference.ts";
import { enterTable, liveTableAccess, TableWidget, type TableHooks } from "./live-table.ts";
import { hydrateMermaid } from "./mermaid.ts";
import { parseTable } from "./table.ts";
import { editorHeading } from "./editor-heading.ts";
import { isPassthroughHref } from "./markdown.ts";
import { FILE_EXTENSION_CLASS, FILE_LINK_CLASS, fileExtensionLabel, renderAssetEmbed } from "./embed-renderers.ts";
import { editingEmbed, WikiEmbedWidget } from "./live-embed.ts";
import { imageLayout, ImageWidget, LIVE_IMAGE_MAX_HEIGHT, liveImageSizing } from "./live-image.ts";

/**
 * Live rendering: Markdown shown in its final look while it is edited. The text itself never changes; only
 * how it is drawn does. The symbols of an element (`#`, `**`, the brackets of a link) are hidden until the
 * cursor or a selection touches that element, which is when they are needed to edit it.
 */

/**
 * A hidden symbol. Those in front of what they mark (`**` before the text, `# `, `[[`) lead into it, and those after it
 * (`**` after the text, `]]`) lead away: a selection that is let go with an edge in a symbol takes the first kind in
 * and leaves the second out.
 */
const hiddenLead = Decoration.mark({ class: "cm-live-hidden", lead: true });
const hiddenTrail = Decoration.mark({ class: "cm-live-hidden", lead: false });

// CodeMirror samples unmarked text to estimate the height of lines outside the viewport.
const styledBlockText = Decoration.mark({ class: "cm-live-block-text" });

/** Where the open file is and what the library holds, so a reference can be checked against real files. */
export interface LiveLibrary {
	/** Library-relative path of the file being edited. */
	fromRelativePath: string;
	assets: readonly Asset[];
}

interface LiveContext extends LiveLibrary {
	lookup: AssetLookup;
}

const setLibrary = StateEffect.define<LiveLibrary>();

/** Holds the library the editor checks references against. Replace it with {@link updateLibrary}. */
const libraryField = StateField.define<LiveContext | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (!effect.is(setLibrary)) continue;
			const library = effect.value;
			if (value?.assets === library.assets && value.fromRelativePath === library.fromRelativePath) return value;
			return { ...library, lookup: value?.assets === library.assets ? value.lookup : createAssetLookup(library.assets) };
		}
		return value;
	},
});

export function initialLiveLibrary(library: LiveLibrary): Extension {
	return libraryField.init(() => ({ ...library, lookup: createAssetLookup(library.assets) }));
}

/** The transaction effect that gives the editor a new library. Dispatch it when the asset list changes. */
export const updateLibrary = (library: LiveLibrary) => setLibrary.of(library);

export function markdownFilePath(state: EditorState): string | undefined {
	return state.field(libraryField, false)?.fromRelativePath;
}

/** Opens a file or heading from a reference in the editor. */
export interface LiveHandlers {
	openAsset(assetId: string, anchor: string | undefined): void;
}
const handlersFacet = Facet.define<LiveHandlers, LiveHandlers | null>({ combine: (values) => values[0] ?? null });
export const liveHandlers = (handlers: LiveHandlers) => handlersFacet.of(handlers);

const tableHooksFacet = Facet.define<TableHooks, TableHooks | null>({ combine: (values) => values[0] ?? null });
/** What the tables drawn in the editor need from the editor's owner: saving, opening a link, and their labels. */
export const liveTables = (hooks: TableHooks) => tableHooksFacet.of(hooks);

/** A bullet in place of the `-`, `*` or `+` that starts a list item. */
class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		const bullet = document.createElement("span");
		bullet.className = "cm-live-bullet";
		bullet.textContent = "•";
		return bullet;
	}
}

class FileExtensionWidget extends WidgetType {
	readonly extension: string;
	constructor(extension: string) {
		super();
		this.extension = extension;
	}
	eq(other: FileExtensionWidget): boolean {
		return this.extension === other.extension;
	}
	toDOM(view: EditorView): HTMLElement {
		const label = view.dom.ownerDocument.createElement("small");
		label.className = FILE_EXTENSION_CLASS;
		label.textContent = this.extension;
		return label;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

/** A checkbox in place of `[ ]` or `[x]`. A click is handled by {@link liveClicks}, which edits the text. */
class CheckboxWidget extends WidgetType {
	readonly checked: boolean;
	readonly readOnly: boolean;
	constructor(checked: boolean, readOnly: boolean) {
		super();
		this.checked = checked;
		this.readOnly = readOnly;
	}
	eq(other: CheckboxWidget): boolean {
		return other.checked === this.checked && other.readOnly === this.readOnly;
	}
	toDOM(): HTMLElement {
		const box = document.createElement("span");
		box.className = this.checked ? "cm-live-checkbox cm-live-checkbox-checked" : "cm-live-checkbox";
		box.setAttribute("role", "checkbox");
		box.setAttribute("aria-checked", String(this.checked));
		box.setAttribute("aria-disabled", String(this.readOnly));
		return box;
	}
	ignoreEvent(): boolean {
		return false;
	}
}

/** A thin line in place of `---`. */
class RuleWidget extends WidgetType {
	eq(): boolean {
		return true;
	}
	toDOM(): HTMLElement {
		const rule = document.createElement("div");
		rule.className = "cm-live-rule";
		return rule;
	}
}

const observers = new WeakMap<HTMLElement, ResizeObserver>();

/**
 * A widget changes size after it is in the page: a picture finishes loading, a diagram is drawn, a font arrives.
 * CodeMirror has to measure again then, or the cursor and the lines below are drawn at the old height.
 */
function remeasureOnResize(dom: HTMLElement, view: EditorView): void {
	if (typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver(() => view.requestMeasure());
	observer.observe(dom);
	observers.set(dom, observer);
}

function stopRemeasuring(dom: HTMLElement): void {
	observers.get(dom)?.disconnect();
	observers.delete(dom);
}

/** Clicking a rendered widget puts the cursor in its text, which brings the source back for editing. */
function enterOnClick(dom: HTMLElement, view: EditorView): void {
	dom.addEventListener("mousedown", (event) => {
		if (view.state.readOnly || event.button !== 0 || event.metaKey || event.ctrlKey) return;
		event.preventDefault();
		view.dispatch({ selection: { anchor: view.posAtDOM(dom) }, scrollIntoView: false });
		view.focus();
	});
}

/** A formula, inline or on its own, rendered by KaTeX. */
class MathWidget extends WidgetType {
	readonly tex: string;
	readonly display: boolean;
	readonly sourceLength: number;
	constructor(tex: string, display: boolean, sourceLength: number) {
		super();
		this.tex = tex;
		this.display = display;
		this.sourceLength = sourceLength;
	}
	eq(other: MathWidget): boolean {
		return other.tex === this.tex && other.display === this.display && other.sourceLength === this.sourceLength;
	}
	toDOM(view: EditorView): HTMLElement {
		const node = document.createElement(this.display ? "div" : "span");
		node.className = this.display ? "cm-live-math cm-live-math-block" : "cm-live-math";
		node.dataset.length = String(this.sourceLength);
		node.innerHTML = renderMath(this.tex, this.display);
		enterOnClick(node, view);
		remeasureOnResize(node, view);
		return node;
	}
	destroy(dom: HTMLElement): void {
		stopRemeasuring(dom);
	}
	/** A block widget needs a height to be measured at all; CodeMirror ignores the measured height of one without. */
	get estimatedHeight(): number {
		return this.display ? 56 : -1;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

/** Diagrams already drawn, by source. A diagram that comes back is built with its picture, so its height is right at once. */
const drawnDiagrams = new Map<string, { html: string; failed: boolean; height: number }>();
const MAX_DRAWN_DIAGRAMS = 50;

/** Asks the block layer to rebuild. Sent once a diagram has been drawn, because its height is only known then. */
const redrawBlocks = StateEffect.define<null>();

/**
 * A Mermaid diagram. It is drawn after the node is in the page. CodeMirror does not re-measure a block widget that
 * grows afterwards, so once drawn, the picture is kept and the block is rebuilt around it.
 */
class MermaidWidget extends WidgetType {
	readonly source: string;
	readonly sourceLength: number;
	readonly drawn: boolean;
	constructor(source: string, sourceLength: number) {
		super();
		this.source = source;
		this.sourceLength = sourceLength;
		this.drawn = drawnDiagrams.has(source);
	}
	eq(other: MermaidWidget): boolean {
		return other.source === this.source && other.drawn === this.drawn && other.sourceLength === this.sourceLength;
	}
	get estimatedHeight(): number {
		return drawnDiagrams.get(this.source)?.height ?? 160;
	}
	toDOM(view: EditorView): HTMLElement {
		const node = document.createElement("div");
		node.className = "cm-live-mermaid";
		node.dataset.length = String(this.sourceLength);
		const diagram = document.createElement("pre");
		diagram.className = "mermaid";
		node.append(diagram);
		enterOnClick(node, view);
		const cached = drawnDiagrams.get(this.source);
		if (cached) {
			diagram.setAttribute("data-processed", "true");
			if (cached.failed) diagram.classList.add("mermaid-failed");
			diagram.innerHTML = cached.html;
			return node;
		}
		diagram.textContent = this.source;
		requestAnimationFrame(() => {
			void hydrateMermaid(node).then(() => {
				if (!node.isConnected || drawnDiagrams.has(this.source)) return;
				if (drawnDiagrams.size >= MAX_DRAWN_DIAGRAMS) drawnDiagrams.delete(drawnDiagrams.keys().next().value!);
				drawnDiagrams.set(this.source, {
					html: diagram.innerHTML,
					failed: diagram.classList.contains("mermaid-failed"),
					height: Math.round(node.getBoundingClientRect().height),
				});
				view.dispatch({ effects: redrawBlocks.of(null) });
			});
		});
		return node;
	}
	ignoreEvent(): boolean {
		return true;
	}
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

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
	SetextHeading1: "cm-live-h1",
	SetextHeading2: "cm-live-h2",
};

/** True when any selection range touches `from..to`, edges included, so a cursor next to a symbol reveals it. */
function touched(state: EditorState, from: number, to: number): boolean {
	return revealRanges(state).some((range) => range.from <= to && range.to >= from);
}

function revealWidgetSource(state: EditorState, from: number, to: number): boolean {
	return !state.field(searchSelection, false) && touched(state, from, to);
}

/**
 * While the mouse button is down, elements keep the look they had when it went down: what was open to source stays
 * open and what was drawn stays drawn, wherever the selection goes. Otherwise the element under the press opens, the
 * ones the drag sweeps over open one by one, and the text moves under the pointer that is aiming at it. The selection
 * takes effect when the button is let go, as in Obsidian. `held` is the ranges that were open at the press.
 */
const setPressed = StateEffect.define<{ held: readonly { from: number; to: number }[] } | null>();
const pressState = StateField.define<{ held: readonly { from: number; to: number }[] } | null>({
	create: () => null,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(setPressed)) return effect.value;
		if (!value) return null;
		// Typing while the button is down, or any change to the text, ends it.
		if (transaction.docChanged) return null;
		return value;
	},
});

/**
 * Whether the editor has the keyboard. A document that has only just been opened has its caret at the start, and nobody
 * has put it there: without focus there is nothing being edited, so nothing is opened to source.
 */
export const setFocused = StateEffect.define<boolean>();
const focusState = StateField.define<boolean>({
	create: () => false,
	update(value, transaction) {
		for (const effect of transaction.effects) if (effect.is(setFocused)) return effect.value;
		return value;
	},
});
const trackFocus = EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing));

/** The ranges whose elements are shown as source: the selection, or while the button is down what was open at the press. */
function revealRanges(state: EditorState): readonly { from: number; to: number }[] {
	if (state.readOnly) return [];
	// States without the editor's fields (the unit tests') show the selection as it is.
	const pressed = state.field(pressState, false);
	if (pressed) return pressed.held;
	if (state.field(focusState, false) === false) return [];
	return state.selection.ranges;
}

/**
 * The selection with each edge that lies in a hidden symbol moved out of it: a start in a symbol that leads into the
 * text goes to the symbol's start, one in a symbol that leads away goes past it, and the same, mirrored, for an end.
 * What is drawn is what is judged, so this is called while the elements are still drawn. Returns null when nothing moves.
 */
export function snapToSymbols(state: EditorState): EditorSelection | null {
	// As drawn while the button was down, so that what is judged is what was seen.
	const drawn = state.field(pressState, false) ? state : state.update({ effects: setPressed.of({ held: [] }) }).state;
	const symbols: { from: number; to: number; lead: boolean }[] = [];
	liveDecorations(drawn).between(0, state.doc.length, (from, to, decoration) => {
		if (decoration.spec.class === "cm-live-hidden") symbols.push({ from, to, lead: decoration.spec.lead === true });
	});
	if (!symbols.length) return null;
	const within = (at: number, lead: boolean) => symbols.filter((symbol) => symbol.lead === lead && symbol.from <= at && at <= symbol.to);
	let moved = false;
	const ranges = state.selection.ranges.map((range) => {
		if (range.empty) return range;
		let from = range.from;
		let to = range.to;
		const leadIn = within(from, true);
		const leadOut = within(from, false);
		if (leadIn.length) from = Math.min(...leadIn.map((symbol) => symbol.from));
		else if (leadOut.length) from = Math.max(...leadOut.map((symbol) => symbol.to));
		const trailIn = within(to, false);
		const trailOut = within(to, true);
		if (trailIn.length) to = Math.max(...trailIn.map((symbol) => symbol.to));
		else if (trailOut.length) to = Math.min(...trailOut.map((symbol) => symbol.from));
		// A selection that held nothing but a symbol is left as it was.
		if (from >= to || (from === range.from && to === range.to)) return range;
		moved = true;
		return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
	});
	return moved ? EditorSelection.create(ranges, state.selection.mainIndex) : null;
}

/** Starts and ends {@link pressState} with the mouse button. */
const trackDrag = EditorView.domEventHandlers({
	mousedown(event, view) {
		// A cell of a drawn table is edited on its own and selects nothing in the document.
		if (event.button !== 0 || (event.target as HTMLElement | null)?.closest(".cm-live-table")) return false;
		const reference = pressedReference(event);
		// What is open now stays as it is until the button is up: the selection it is about to make does not open anything.
		view.dispatch({ effects: setPressed.of({ held: revealRanges(view.state).map(({ from, to }) => ({ from, to })) }) });
		const end = (event: Event) => {
			document.removeEventListener("mouseup", end, true);
			window.removeEventListener("blur", end);
			if (!view.state.field(pressState, false)) return;
			const link = event instanceof MouseEvent ? reference?.(event) : null;
			// The symbols at the edges of what was swept over are part of it, as it looked while it was dragged.
			const selection = snapToSymbols(view.state);
			view.dispatch({ effects: setPressed.of(null), ...(selection ? { selection } : {}) });
			// Revealing inline markup can move text to another visual row. Flush the new selection geometry now.
			if (!view.state.readOnly && !view.state.selection.main.empty) view.coordsAtPos(view.state.selection.main.head);
			if (link) view.state.facet(handlersFacet)?.openAsset(link.dataset.assetId ?? "", link.dataset.anchor);
		};
		document.addEventListener("mouseup", end, true);
		window.addEventListener("blur", end);
		return false;
	},
});

export function liveDecorations(state: EditorState, from = 0, to = state.doc.length): DecorationSet {
	const found: Range<Decoration>[] = [];

	const quotes = new Map<number, { depth: number; marks: { from: number; to: number }[] }>();
	/** True when a selection touches the line: block marks (`>`, `-`, `[ ]`, `---`) show their text then. */
	const onLine = (position: number) => {
		const text = state.doc.lineAt(position);
		return touched(state, text.from, text.to);
	};

	syntaxTree(state).iterate({
		from,
		to,
		enter(node) {
			if (node.name === "QuoteMark") {
				const text = state.doc.lineAt(node.from);
				const entry = quotes.get(text.from) ?? { depth: 0, marks: [] };
				entry.depth += 1;
				entry.marks.push({ from: node.from, to: state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to });
				quotes.set(text.from, entry);
				return;
			}
			if (node.name === "HorizontalRule") {
				if (!onLine(node.from)) found.push(rule.range(node.from, node.to));
				return;
			}
			if (node.name === "ListMark") {
				const item = node.node.parent;
				if (item?.parent?.name !== "BulletList") return;
				const text = state.doc.lineAt(node.from);
				const indent = state.doc.sliceString(text.from, node.from);
				// Nested items are indented with spaces, which are narrow in a proportional font: widen them.
				if (indent.length > 0 && /^ +$/.test(indent)) found.push(Decoration.mark({ class: "cm-live-indent", attributes: { style: `letter-spacing:${(indent.length * 0.45).toFixed(2)}em` } }).range(text.from, node.from));
				if (onLine(node.from)) return;
				const task = item.getChild("Task")?.getChild("TaskMarker");
				if (task) found.push(hiddenLead.range(node.from, Math.min(task.from, node.to + 1)));
				else found.push(bullet.range(node.from, node.to));
				return;
			}
			if (node.name === "TaskMarker") {
				const written = state.doc.sliceString(node.from, node.to);
				if (!/^\[[ xX]\]$/.test(written)) return;
				found.push(Decoration.line({ class: written === "[ ]" ? "cm-live-task" : "cm-live-task cm-live-task-done" }).range(state.doc.lineAt(node.from).from));
				if (!onLine(node.from)) found.push(Decoration.replace({ widget: new CheckboxWidget(written !== "[ ]", state.readOnly) }).range(node.from, node.to));
				return;
			}
			if (node.name === "FencedCode") {
				fencedCode(state, node.node, found);
				return false;
			}
			if (node.name === "CodeBlock") {
				for (let at = node.from; at <= node.to; ) {
					const text = state.doc.lineAt(at);
					found.push(Decoration.line({ class: "cm-live-codeblock" }).range(text.from));
					if (text.length) found.push(styledBlockText.range(text.from, text.to));
					at = text.to + 1;
				}
				return false;
			}
			const heading = HEADINGS[node.name];
			if (heading) {
				for (let at = node.from; at <= node.to; ) {
					const text = state.doc.lineAt(at);
					const info = editorHeading(state, node)!;
					found.push(Decoration.line({ class: heading, attributes: { role: "heading", "aria-level": String(info.level), "data-heading": info.key } }).range(text.from));
					if (text.length) found.push(styledBlockText.range(text.from, text.to));
					at = text.to + 1;
				}
				// The `#` marks and the one space after them.
				const mark = node.node.getChild("HeaderMark");
				if (mark && !touched(state, node.from, node.to)) {
					if (node.name.startsWith("Setext")) found.push(hiddenTrail.range(mark.from, mark.to));
					else {
						const end = state.doc.sliceString(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to;
						found.push(hiddenLead.range(mark.from, end));
					}
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
					found.push(hiddenLead.range(first.from, first.to), hiddenTrail.range(last.from, last.to));
				}
				return;
			}
			if (node.name === "Autolink" || (node.name === "URL" && node.node.parent?.name === "Paragraph")) {
				const url = node.name === "URL" ? node.node : node.node.getChild("URL");
				if (!url) return;
				let href = state.doc.sliceString(url.from, url.to);
				if (node.name === "Autolink" && !href.includes(":") && href.includes("@")) href = `mailto:${href}`;
				found.push(Decoration.mark({ attributes: linkAttributes(state, href) }).range(url.from, url.to));
				if (node.name === "Autolink" && !touched(state, node.from, node.to)) {
					found.push(hiddenLead.range(node.from, url.from), hiddenTrail.range(url.to, node.to));
				}
				return false;
			}
			if (node.name === "Link") {
				// `[text](url "title")`: keep the text, hide everything else once the cursor leaves.
				const marks = node.node.getChildren("LinkMark");
				const close = marks[1];
				if (!close || state.doc.sliceString(close.from, close.from + 2) !== "](") return;
				const url = node.node.getChild("URL");
				const attributes = url ? linkAttributes(state, state.doc.sliceString(url.from, url.to)) : { class: "cm-live-link" };
				found.push(Decoration.mark({ attributes }).range(marks[0].to, close.from));
				if (!touched(state, node.from, node.to)) {
					found.push(hiddenLead.range(marks[0].from, marks[0].to), hiddenTrail.range(close.from, node.to));
				}
			}
		},
	});
	for (const [start, quote] of quotes) {
		// One bar for each level of nesting, drawn as a background so the line's own text stays untouched.
		const bars = Array.from({ length: quote.depth }, (_, level) => `linear-gradient(var(--lm-border-strong), var(--lm-border-strong)) ${level * 16}px 0 / 3px 100% no-repeat`).join(", ");
		found.push(Decoration.line({ class: "cm-live-quote", attributes: { style: `padding-left:${quote.depth * 16}px;background:${bars}` } }).range(start));
		if (!onLine(start)) for (const mark of quote.marks) found.push(hiddenLead.range(mark.from, mark.to));
	}
	wikiLinks(state, from, to, found);
	inlineMath(state, from, to, found);
	const builder = new RangeSetBuilder<Decoration>();
	found.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide || a.to - b.to);
	for (const range of found) builder.add(range.from, range.to, range.value);
	return builder.finish();
}

type SyntaxNodeRef = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/**
 * A fenced block: every line gets the code background. The fence lines (``` and the language) collapse to a thin
 * strip until the cursor is in the block. Diagrams are drawn in their place by {@link liveBlockDecorations}.
 */
function fencedCode(state: EditorState, node: SyntaxNodeRef, found: Range<Decoration>[]): void {
	const first = state.doc.lineAt(node.from).number;
	const last = state.doc.lineAt(node.to).number;
	const marks = node.getChildren("CodeMark");
	const closed = marks.length > 1;
	const reveal = touched(state, node.from, node.to);
	for (let number = first; number <= last; number++) {
		const text = state.doc.line(number);
		const fence = number === first || (closed && number === last);
		const classes = ["cm-live-codeblock"];
		if (number === first) classes.push("cm-live-codeblock-first");
		if (number === last) classes.push("cm-live-codeblock-last");
		if (fence && !reveal) classes.push("cm-live-fence");
		found.push(Decoration.line({ class: classes.join(" ") }).range(text.from));
		if (text.length) found.push(styledBlockText.range(text.from, text.to));
		if (fence && !reveal) {
			const start = Math.max(text.from, number === first ? node.from : marks[marks.length - 1].from);
			if (start < text.to) found.push((number === first ? hiddenLead : hiddenTrail).range(start, text.to));
		}
	}
}

/** Formulas written on one line: `$x$`, `$$x$$` and `\(x\)`. Found with the same rules the preview runs. */
function inlineMath(state: EditorState, from: number, to: number, found: Range<Decoration>[]): void {
	const tree = syntaxTree(state);
	const first = state.doc.lineAt(from).from;
	const last = state.doc.lineAt(to).to;
	for (let at = first; at <= last; ) {
		const line = state.doc.lineAt(at);
		at = line.to + 1;
		if (!line.text.includes("$") && !line.text.includes("\\(")) continue;
		for (let offset = 0; offset < line.text.length; offset++) {
			const char = line.text[offset];
			if (char !== "$" && !(char === "\\" && line.text[offset + 1] === "(")) continue;
			const match = matchInlineMath(line.text, offset);
			if (!match) continue;
			const start = line.from + offset;
			const end = line.from + match.end;
			offset = match.end - 1; // Whatever sits inside a formula is not another one.
			if (insideCode(tree, start)) continue;
			// A formula that makes up a whole paragraph is the block's, which draws it.
			let paragraph: SyntaxNodeRef | null = tree.resolveInner(start, 1);
			while (paragraph && paragraph.name !== "Paragraph") paragraph = paragraph.parent;
			if (paragraph && mathBlock(state, paragraph)) continue;
			if (revealWidgetSource(state, start, end)) {
				found.push(Decoration.mark({ class: "cm-live-math-source" }).range(start, end));
			} else {
				found.push(Decoration.replace({ widget: new MathWidget(match.tex, match.display, end - start) }).range(start, end));
			}
		}
	}
}

/** True when `position` is in code, where nothing is Markdown. Unlike {@link insideLiteral}, an escape does not count. */
function insideCode(tree: ReturnType<typeof syntaxTree>, position: number): boolean {
	for (let node: SyntaxNodeRef | null = tree.resolveInner(position, 1); node; node = node.parent) {
		if (node.name === "InlineCode" || node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "CodeText" || node.name === "URL") return true;
	}
	return false;
}

/** The formula a paragraph consists of, when it is a block of its own (`$$ … $$` over one or more lines). */
function mathBlock(state: EditorState, paragraph: SyntaxNodeRef): { tex: string } | null {
	if (paragraph.parent?.name !== "Document") return null;
	const text = state.doc.sliceString(paragraph.from, paragraph.to);
	const match = matchBlockMath(text);
	return match && match.end === text.length ? { tex: match.tex } : null;
}

/**
 * Whole blocks drawn in place of their text: a formula on its own lines, a Mermaid diagram and a table. A replacement
 * that spans lines may only come from a state field, so this is kept apart from {@link liveDecorations}.
 */
export function liveBlockDecorations(state: EditorState): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	syntaxTree(state).iterate({
		enter(node) {
			if (node.name === "Document") return;
			if (node.name === "Paragraph") {
				const math = mathBlock(state, node.node);
				if (math && !revealWidgetSource(state, node.from, node.to)) {
					builder.add(node.from, node.to, Decoration.replace({ widget: new MathWidget(math.tex, true, node.to - node.from), block: true }));
				}
			} else if (node.name === "Table" && node.node.parent?.name === "Document") {
				const text = state.doc.sliceString(node.from, node.to);
				const table = parseTable(text);
				// A table that reads as one is always drawn. A caret in it, or a selection over it, changes nothing.
				if (table) {
					const context = state.field(libraryField, false) ?? null;
					const widget = new TableWidget(text, table.rows.length, context, (view) => view.state.facet(tableHooksFacet), redrawBlocks);
					builder.add(node.from, node.to, Decoration.replace({ widget, block: true }));
				}
			} else if (node.name === "FencedCode" && node.node.parent?.name === "Document") {
				const info = node.node.getChild("CodeInfo");
				const language = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]?.toLowerCase() : "";
				const code = node.node.getChild("CodeText");
				if (language === "mermaid" && code && node.node.getChildren("CodeMark").length > 1 && !revealWidgetSource(state, node.from, node.to)) {
					builder.add(node.from, node.to, Decoration.replace({ widget: new MermaidWidget(state.doc.sliceString(code.from, code.to), node.to - node.from), block: true }));
				}
			}
			return false;
		},
	});
	return builder.finish();
}

/** Draws {@link liveBlockDecorations}. Add it next to {@link liveMarkdown}. */
const blockDecorations = StateField.define<DecorationSet>({
	create: (state) => liveBlockDecorations(state),
	update(value, transaction) {
		const treeChanged = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
		const redraw = transaction.effects.some((effect) => effect.is(redrawBlocks));
		const dragChanged = transaction.startState.field(pressState, false) !== transaction.state.field(pressState, false)
			|| transaction.startState.field(focusState, false) !== transaction.state.field(focusState, false);
		const searchChanged = transaction.startState.field(searchSelection, false) !== transaction.state.field(searchSelection, false);
		const accessChanged = transaction.startState.readOnly !== transaction.state.readOnly;
		return transaction.docChanged || treeChanged || redraw || accessChanged || (!transaction.state.readOnly && (transaction.selection || dragChanged || searchChanged)) ? liveBlockDecorations(transaction.state) : value;
	},
	provide: (field) => EditorView.decorations.from(field),
});
/**
 * A selection that begins or ends inside a drawn table takes the whole table in. The table shows no caret and no
 * highlight inside it, so a selection that ended in the middle of it could not be seen, and deleting it would cut a
 * line of the table in two. A caret alone, or a selection that is wholly inside one table, is left as it is.
 */
const snapSelection = EditorState.transactionFilter.of((transaction) => {
	if (!transaction.selection) return transaction;
	const drawn = transaction.state.field(blockDecorations, false);
	if (!drawn) return transaction;
	const tables: { from: number; to: number }[] = [];
	drawn.between(0, transaction.state.doc.length, (from, to, decoration) => {
		if (decoration.spec.widget instanceof TableWidget) tables.push({ from, to });
	});
	if (!tables.length) return transaction;
	let moved = false;
	const ranges = transaction.selection.ranges.map((range) => {
		if (range.empty) return range;
		let from = range.from;
		let to = range.to;
		for (const table of tables) {
			if (from >= table.from && to <= table.to) continue; // inside one table: left to the cells
			if (from > table.from && from < table.to) from = table.from;
			if (to > table.from && to < table.to) to = table.to;
			// A selection from above that ends on the table's first position is a caret there for a drawn table, which
			// shows none: it reaches the table, so the table goes in whole. One that starts at the table's end does not.
			if (from < table.from && to === table.from) to = table.to;
		}
		if (from === range.from && to === range.to) return range;
		moved = true;
		return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
	});
	if (!moved) return transaction;
	return [transaction, { selection: EditorSelection.create(ranges, transaction.selection.mainIndex), sequential: true }];
});

/**
 * Marks the tables a selection covers, so that a selected table can be seen as selected. The class goes on the table's
 * own element and the table is not rebuilt.
 */
const markSelectedTables = ViewPlugin.fromClass(class {
	constructor(view: EditorView) {
		this.mark(view);
	}
	update(update: ViewUpdate): void {
		if (update.selectionSet || update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((t) => t.effects.length)) this.mark(update.view);
	}
	mark(view: EditorView): void {
		// Measured after CodeMirror has laid the document out, as the tables' elements are made then.
		view.requestMeasure({
			read: () => {
				const selected: number[] = [];
				for (const range of view.state.selection.ranges) {
					if (range.empty) continue;
					selected.push(range.from, range.to);
				}
				return selected;
			},
			write: (bounds) => {
				for (const element of view.contentDOM.querySelectorAll<HTMLElement>(".cm-live-table")) {
					const from = view.posAtDOM(element);
					const to = from + (Number(element.dataset.length) || 0);
					let covered = false;
					for (let at = 0; at < bounds.length; at += 2) if (bounds[at] <= from && bounds[at + 1] >= to) covered = true;
					element.classList.toggle("cm-live-table-selected", covered);
				}
			},
		});
	}
});

export const liveBlocks: Extension = [blockDecorations, liveTableAccess, snapSelection, markSelectedTables];

/** Keeps what a drag sweeps over drawn until the button is let go. Add it before {@link liveMarkdown} and {@link liveBlocks}. */
export const liveDrag: Extension = [
	pressState,
	trackDrag,
	focusState,
	trackFocus,
	EditorView.contentAttributes.compute([pressState], (state): Record<string, string> =>
		state.field(pressState) ? { class: "cm-live-selecting" } : {}),
];

/**
 * Arrow keys step into a drawn block instead of over it. CodeMirror's vertical move is by screen position and
 * passes a replaced block without stopping, so a table, a formula or a diagram could only be reached with the
 * mouse. This asks where the default move would land and, when a block lies between, goes to the nearest one.
 * A table takes the caret in its nearest row; the others show their text, with the caret at the edge it came from.
 */
function stepIntoBlock(direction: "up" | "down") {
	return (view: EditorView): boolean => {
		const { selection } = view.state;
		if (selection.ranges.length !== 1 || !selection.main.empty) return false;
		const start = selection.main.head;
		const landing = view.moveVertically(selection.main, direction === "down").head;
		let nearest: { from: number; to: number; table: boolean } | null = null;
		const from = Math.min(start, landing);
		const to = Math.max(start, landing);
		for (const field of [blockDecorations, imageDecorations]) {
			view.state.field(field, false)?.between(from, to, (blockFrom, blockTo, decoration) => {
				// Only a block the move passes over; one that holds the start or the landing is already being edited.
				if (!decoration.spec.block || blockFrom < from || blockTo > to) return;
				const closer = !nearest || (direction === "down" ? blockFrom < nearest.from : blockTo > nearest.to);
				if (closer) nearest = { from: blockFrom, to: blockTo, table: decoration.spec.widget instanceof TableWidget };
			});
		}
		const block = nearest as { from: number; to: number; table: boolean } | null;
		if (!block) return false;
		if (block.table && enterTable(view, block.from, direction === "up" ? "last" : "first")) return true;
		view.dispatch({ selection: { anchor: direction === "up" ? block.to : block.from }, scrollIntoView: true });
		return true;
	};
}

/**
 * Up and down inside a line that wraps. The caret in a formula shows its source, which is longer than the formula
 * and can push the end of the line onto a second row. Down then lands on that row, outside the formula, the source
 * folds back, the line is one row again and the caret is still where it was in height: the move seems to have
 * jumped over what followed. When a move within one line shows no change in height, go on to the next line.
 */
function stepWithinLine(forward: boolean) {
	return (view: EditorView): boolean => {
		const { selection } = view.state;
		if (selection.ranges.length !== 1 || !selection.main.empty) return false;
		const range = selection.main;
		const landing = view.moveVertically(range, forward);
		if (landing.head === range.head || view.state.doc.lineAt(landing.head).number !== view.state.doc.lineAt(range.head).number) return false;
		const before = view.coordsAtPos(range.head, range.assoc || 1)?.top;
		view.dispatch({ selection: landing, scrollIntoView: true, userEvent: "select" });
		const after = view.coordsAtPos(landing.head, landing.assoc || 1)?.top;
		if (before == null || after == null || (forward ? after > before + 2 : after < before - 2)) return true;
		view.dispatch({ selection: view.moveVertically(view.state.selection.main, forward), scrollIntoView: true, userEvent: "select" });
		return true;
	};
}

/**
 * Left and right arrows into a table. A caret that reaches the edge of a table is inside it, and a drawn table
 * cannot show a caret, so it would turn into its source. Entering its first or last cell is what the move means.
 */
function stepIntoTable(forward: boolean) {
	return (view: EditorView): boolean => {
		const { selection } = view.state;
		if (selection.ranges.length !== 1 || !selection.main.empty) return false;
		const start = selection.main.head;
		const landing = view.moveByChar(selection.main, forward).head;
		let table: { from: number; to: number } | null = null;
		view.state.field(blockDecorations).between(Math.min(start, landing), Math.max(start, landing), (from, to, decoration) => {
			if (decoration.spec.widget instanceof TableWidget && (start < from || start > to)) table = { from, to };
		});
		const found = table as { from: number; to: number } | null;
		return !!found && enterTable(view, found.from, forward ? "first" : "last", "char");
	};
}

/** Add this next to {@link liveBlocks}. */
export const liveBlockKeys = keymap.of([
	{ key: "ArrowUp", run: stepIntoBlock("up") },
	{ key: "ArrowDown", run: stepIntoBlock("down") },
	{ key: "ArrowUp", run: stepWithinLine(false) },
	{ key: "ArrowDown", run: stepWithinLine(true) },
	{ key: "ArrowRight", run: stepIntoTable(true) },
	{ key: "ArrowLeft", run: stepIntoTable(false) },
]);

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

export function insideLiteral(tree: ReturnType<typeof syntaxTree>, from: number, to: number): boolean {
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
	const anchor = hash === -1 ? undefined : anchorOf(match.target.slice(hash + 1));
	const localHeading = hash === 0 && !!anchor;
	if (asset === null && !localHeading) return;
	const editing = touched(state, range.from, range.to);
	const missing = asset === undefined;

	if (match.embed && !localHeading && asset?.relativePath !== context.fromRelativePath) {
		if (asset && state.field(editingEmbed, false)?.from !== range.from) {
			const html = renderAssetEmbed(asset, match, anchor, { interactiveHtml: true });
			const noteContext = isMarkdownFile(asset.relativePath) ? context : undefined;
			const widget = new WikiEmbedWidget(range.to - range.from, asset.assetId, anchor, html, state.facet(handlersFacet)?.openAsset, noteContext);
			found.push(Decoration.replace({ widget }).range(range.from, range.to));
			return;
		}
		found.push(Decoration.mark({ class: missing ? "cm-live-broken" : "cm-live-link" }).range(range.from, range.to));
		return;
	}
	const open = range.from + (match.embed ? 3 : 2);
	const close = range.to - 2;
	const attributes: Record<string, string> = { class: missing ? "cm-live-wiki cm-live-broken" : `cm-live-wiki cm-live-link ${FILE_LINK_CLASS}` };
	if (asset) attributes["data-asset-id"] = asset.assetId;
	if (anchor) attributes["data-anchor"] = anchor;
	if (editing) {
		found.push(Decoration.mark({ attributes }).range(open, close));
		return;
	}
	// Away from the cursor: the display name if there is one, else the path; the brackets and the rest are hidden.
	const inner = state.doc.sliceString(open, close);
	const labelOffset = match.label ? inner.indexOf("|") + 1 : 0;
	const displayed = inner.slice(labelOffset);
	const labelFrom = open + labelOffset + displayed.length - displayed.trimStart().length;
	const labelTo = open + labelOffset + displayed.trimEnd().length;
	const extension = asset && fileExtensionLabel(asset, match);
	found.push(hiddenLead.range(range.from, open));
	if (labelFrom > open) found.push(hiddenLead.range(open, labelFrom));
	found.push(Decoration.mark({ attributes, inclusiveEnd: !!extension }).range(labelFrom, labelTo));
	if (extension) found.push(Decoration.widget({ widget: new FileExtensionWidget(extension), side: -1 }).range(labelTo));
	found.push(hiddenTrail.range(labelTo, range.to));
}

/** Ordinary Markdown links use the same resolver as wiki links and the HTML preview. */
function linkAttributes(state: EditorState, href: string): Record<string, string> {
	const attributes: Record<string, string> = { class: "cm-live-link" };
	const context = state.field(libraryField, false);
	const hash = href.indexOf("#");
	const anchor = hash === -1 ? undefined : anchorOf(href.slice(hash + 1));
	if (href.startsWith("#")) {
		if (anchor) attributes["data-anchor"] = anchor;
	} else if (isPassthroughHref(href)) {
		if (/^(https?:|mailto:)/i.test(href)) attributes["data-href"] = href;
	} else if (context) {
		const asset = resolveLinkTarget(context.fromRelativePath, href, context.lookup);
		if (asset) {
			attributes["data-asset-id"] = asset.assetId;
			if (anchor) attributes["data-anchor"] = anchor;
		} else if (asset === undefined) attributes.class = "cm-live-broken";
	}
	return attributes;
}

/** `![alt](picture.png)` with a library path shows the picture; an address that is not in the library is flagged. */
export function markdownImageDecorations(state: EditorState): DecorationSet {
	const context = state.field(libraryField, false);
	if (!context) return Decoration.none;
	const found: Range<Decoration>[] = [];
	syntaxTree(state).iterate({
		enter(node) {
			if (node.name !== "Image") return;
			const url = node.node.getChild("URL");
			if (!url) return;
			const written = state.doc.sliceString(url.from, url.to);
			const asset = resolveLinkTarget(context.fromRelativePath, written, context.lookup);
			const remote = asset === null && /^https?:/i.test(written);
			if (asset === null && !remote) return;
			const line = state.doc.lineAt(node.from);
			const block = node.to <= line.to && node.node.parent?.parent?.name === "Document"
				&& !state.doc.sliceString(line.from, node.from).trim() && !state.doc.sliceString(node.to, line.to).trim();
			const from = block ? line.from : node.from;
			const to = block ? line.to : node.to;
			if ((asset || remote) && !touched(state, from, to)) {
				const alt = state.doc.sliceString(node.from + 2, state.doc.sliceString(node.from, node.to).indexOf("](") + node.from);
				const widget = new ImageWidget(asset ? assetPreviewUrl(asset) : written, alt, block, state);
				found.push(Decoration.replace({ widget, block }).range(from, to));
			} else if (!asset && !remote) {
				found.push(Decoration.mark({ class: "cm-live-broken" }).range(node.from, node.to));
			}
		},
	});
	return Decoration.set(found, true);
}

const imageDecorations = StateField.define<DecorationSet>({
	create: markdownImageDecorations,
	update(decorations, { startState, state, docChanged, selection }) {
		if (docChanged || selection || syntaxTree(startState) !== syntaxTree(state) || startState.readOnly !== state.readOnly
			|| startState.field(imageLayout, false) !== state.field(imageLayout) || startState.field(libraryField, false) !== state.field(libraryField, false)
			|| startState.field(pressState, false) !== state.field(pressState, false) || startState.field(focusState, false) !== state.field(focusState, false)) {
			return markdownImageDecorations(state);
		}
		return decorations;
	},
	provide: (field) => EditorView.decorations.from(field),
});

export const liveImages = liveImageSizing(imageDecorations);

/** Decorations for the part of the document in view, rebuilt when the text, the cursor or the parse changes. */
export const liveMarkdown = ViewPlugin.fromClass(class {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.selectionSet || update.viewportChanged || update.startState.readOnly !== update.state.readOnly || syntaxTree(update.startState) !== syntaxTree(update.state)
			|| update.startState.field(pressState, false) !== update.state.field(pressState, false)
			|| update.startState.field(focusState, false) !== update.state.field(focusState, false)
			|| update.startState.field(editingEmbed, false) !== update.state.field(editingEmbed, false)
			|| update.startState.field(searchSelection, false) !== update.state.field(searchSelection, false)
			|| update.startState.field(libraryField, false) !== update.state.field(libraryField, false)) {
			this.decorations = this.build(update.view);
		}
	}

	build(view: EditorView): DecorationSet {
		const { from, to } = view.viewport;
		return liveDecorations(view.state, from, to);
	}
}, { decorations: (plugin) => plugin.decorations });

const referencesInContent = liveReferenceSelectors.map((selector) => `.cm-content ${selector}`);

export const liveMarkdownTheme = EditorView.theme({
	// Keep a zero-width position for vertical caret movement. During a mouse selection, the mark's box at the
	// baseline can make hit testing skip visible text on its far side, so only its text remains in the layout.
	".cm-live-hidden": { fontSize: "0", letterSpacing: "0" },
	".cm-live-selecting .cm-live-hidden": { display: "contents" },
	".cm-live-strong": { fontWeight: "var(--lm-weight-semibold)" },
	".cm-live-emphasis": { fontStyle: "italic" },
	".cm-live-strike": { textDecoration: "line-through" },
	".cm-live-code, .cm-live-table code": {
		padding: "0.1em 0.35em",
		borderRadius: "var(--lm-radius-sm)",
		// Keep the selection layer behind the text visible through the inline code tint.
		backgroundColor: "color-mix(in srgb, var(--lm-text-primary) 7%, transparent)",
		fontFamily: "var(--lm-font-mono)",
		fontSize: "0.86em",
	},
	".cm-live-broken": { whiteSpace: "nowrap", color: "var(--lm-text-danger)", textDecoration: "underline wavy", textUnderlineOffset: "3px" },
	[referencesInContent.join(", ")]: { cursor: "pointer" },
	[referencesInContent.map((selector) => `${selector}:hover`).join(", ")]: { textDecorationThickness: "2px" },
	".cm-live-image": { maxWidth: "100%", maxHeight: `${LIVE_IMAGE_MAX_HEIGHT}px`, width: "auto", height: "auto", borderRadius: "var(--lm-radius-sm)", verticalAlign: "middle" },
	".cm-live-codeblock": {
		position: "relative",
		fontFamily: "var(--lm-font-mono)",
		fontSize: "0.88em",
		padding: "0 14px",
	},
	// CodeMirror draws selection at -2 in the scroller. Paint the code background below it and the text above it.
	".cm-live-codeblock::before": {
		content: '""',
		position: "absolute",
		inset: "0",
		zIndex: "-3",
		backgroundColor: "var(--lm-surface-hover)",
		borderRadius: "inherit",
		pointerEvents: "none",
	},
	".cm-live-codeblock-first": { borderTopLeftRadius: "var(--lm-radius-sm)", borderTopRightRadius: "var(--lm-radius-sm)" },
	".cm-live-codeblock-last": { borderBottomLeftRadius: "var(--lm-radius-sm)", borderBottomRightRadius: "var(--lm-radius-sm)" },
	".cm-live-fence": { height: "0.7em", lineHeight: "0.7em", overflow: "hidden" },
	".cm-live-math": { cursor: "text" },
	".cm-live-math-block": { padding: "0.4em 0", overflowX: "auto", textAlign: "center" },
	".cm-live-math-source": { fontFamily: "var(--lm-font-mono)", fontSize: "0.9em", color: "var(--lm-text-secondary)" },
	// A block, not a flex row: the SVG is `width: 100%`, which a shrink-to-fit parent would collapse to a few hundred pixels.
	".cm-live-mermaid": { padding: "0.4em 0", textAlign: "center", cursor: "text" },
	".cm-live-mermaid pre.mermaid": { margin: "0", padding: "var(--lm-space-4) 0", overflow: "visible", background: "transparent" },
	".cm-live-mermaid pre.mermaid:not([data-processed]), .cm-live-mermaid pre.mermaid.mermaid-failed": {
		color: "var(--lm-text-muted)",
		fontSize: "var(--lm-text-size-sm)",
		textAlign: "left",
		whiteSpace: "pre-wrap",
	},
	".cm-live-mermaid svg": { maxWidth: "100%", height: "auto" },
	// Space around a drawn block is padding, not margin: a click in a margin lands on the block and puts the caret at its start.
	// The strip to the left is where the row grips show. Its negative margin takes it back out of the layout, so the table
	// stays level with the text, and it is padding, not margin, so that the pointer is over the table while it is there.
	".cm-live-table": { position: "relative", margin: "0 0 0 -20px", padding: "18px 18px 18px 20px" },
	".cm-live-table-scroll": { overflowX: "auto" },
	".cm-live-table-edit-controls": { display: "contents" },
	"&.cm-markdown-read .cm-live-table-edit-controls": { display: "none" },
	// A table that a selection covers has the selection's own colour, as the lines around it do.
	// Written with the table's own class as well, so that it outweighs the header's background.
	".cm-live-table.cm-live-table-selected table": { backgroundColor: "var(--markdown-selection-bg)" },
	".cm-live-table.cm-live-table-selected th, .cm-live-table.cm-live-table-selected td": { backgroundColor: "transparent" },
	// The table is marked as a whole: the browser's own highlight on the text inside it would paint over that, piece by piece.
	".cm-content .cm-live-table-selected ::selection": { backgroundColor: "transparent" },
	".cm-live-table table": { borderCollapse: "collapse", minWidth: "100%" },
	".cm-live-table th, .cm-live-table td": {
		// Border-box, so this is the width with the padding: room for three characters. A wider table scrolls.
		minWidth: "4.5em",
		padding: "var(--lm-space-3) var(--lm-space-5)",
		border: "1px solid var(--lm-border-default)",
		verticalAlign: "top",
		outline: "none",
		whiteSpace: "pre-wrap",
		overflowWrap: "break-word",
	},
	".cm-live-table th": { fontWeight: "var(--lm-weight-semibold)", backgroundColor: "var(--lm-surface-subtle)", textAlign: "left" },
	".cm-live-table th:focus, .cm-live-table td:focus": {
		backgroundColor: "var(--lm-surface-accent)",
		boxShadow: "inset 0 0 0 1.5px var(--lm-border-accent)",
	},
	".cm-live-table a:not(.markdown-file-link)": { color: "var(--lm-text-accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
	".cm-live-table img": { maxWidth: "100%", maxHeight: "200px" },
	".cm-live-table .markdown-broken-reference": { color: "var(--lm-text-danger)", textDecoration: "underline wavy", textUnderlineOffset: "3px" },
	".cm-live-table-add-row, .cm-live-table-add-column": {
		position: "absolute",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		padding: "0",
		border: "none",
		borderRadius: "var(--lm-radius-sm)",
		color: "var(--lm-text-muted)",
		backgroundColor: "transparent",
		fontSize: "14px",
		lineHeight: "1",
		cursor: "pointer",
		opacity: "0",
	},
	".cm-live-table-add-row": { left: "20px", right: "18px", bottom: "0", height: "18px" },
	".cm-live-table-add-column": { top: "18px", right: "0", bottom: "18px", width: "18px" },
	// The grips for moving a row (left of the table, in its left edge) and a column (above it), and the line that marks the drop.
	".cm-live-table-handle": {
		position: "absolute",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		boxSizing: "border-box",
		borderRadius: "var(--lm-radius-sm)",
		color: "var(--lm-text-muted)",
		cursor: "grab",
		userSelect: "none",
		backgroundColor: "var(--lm-surface-subtle)",
		border: "1px solid var(--lm-border-default)",
		zIndex: "1",
	},
	".cm-live-table-handle[hidden]": { display: "none" },
	// The column's grip is flat and the row's is tall, as each lies along the edge it is on.
	".cm-live-table-handle-column": { width: "22px", height: "12px" },
	".cm-live-table-handle-row": { width: "12px", height: "22px" },
	".cm-live-table-dots": {
		display: "block",
		backgroundImage: "radial-gradient(circle, currentColor 0.8px, transparent 1.2px)",
		backgroundSize: "4px 4px",
	},
	".cm-live-table-handle-column .cm-live-table-dots": { width: "12px", height: "8px" },
	".cm-live-table-handle-row .cm-live-table-dots": { width: "8px", height: "12px" },
	".cm-live-table-handle:hover": { backgroundColor: "var(--lm-surface-hover)", color: "var(--lm-text-primary)" },
	".cm-live-table-dragging, .cm-live-table-dragging *": { cursor: "grabbing", userSelect: "none" },
	".cm-live-table-drop": { position: "absolute", backgroundColor: "var(--lm-text-accent)", pointerEvents: "none", zIndex: "2" },
	".cm-live-table-drop[hidden]": { display: "none" },
	// A frame over the row or column being moved, drawn over the cells without taking the pointer from them.
	".cm-live-table-range": {
		position: "absolute",
		boxSizing: "border-box",
		border: "2px solid var(--lm-text-accent)",
		backgroundColor: "color-mix(in srgb, var(--lm-text-accent) 12%, transparent)",
		pointerEvents: "none",
		zIndex: "1",
	},
	".cm-live-table:focus": { outline: "none" },
	// While cells are being picked by dragging, the text under the pointer is not selected as it goes.
	".cm-live-table-picking, .cm-live-table-picking *": { userSelect: "none", cursor: "default" },
	".cm-live-table-frame": {
		position: "absolute",
		boxSizing: "border-box",
		border: "2px solid var(--lm-text-accent)",
		borderRadius: "var(--lm-radius-sm)",
		backgroundColor: "color-mix(in srgb, var(--lm-text-accent) 10%, transparent)",
		pointerEvents: "none",
		zIndex: "1",
	},
	".cm-live-table-frame[hidden]": { display: "none" },
	".cm-live-table:hover .cm-live-table-add-row, .cm-live-table:hover .cm-live-table-add-column, .cm-live-table:focus-within .cm-live-table-add-row, .cm-live-table:focus-within .cm-live-table-add-column": { opacity: "1" },
	".cm-live-table-add-row:hover, .cm-live-table-add-column:hover": { backgroundColor: "var(--lm-surface-hover)", color: "var(--lm-text-primary)" },
	".cm-live-quote": { color: "var(--lm-text-secondary)" },
	".cm-live-bullet": { display: "inline-block", width: "1em", textAlign: "center", color: "var(--lm-text-secondary)" },
	".cm-live-checkbox": {
		display: "inline-block",
		boxSizing: "border-box",
		width: "1em",
		height: "1em",
		margin: "0 0.35em 0 0.1em",
		verticalAlign: "-0.12em",
		border: "1.5px solid var(--lm-border-strong)",
		borderRadius: "var(--lm-radius-sm)",
		cursor: "pointer",
	},
	".cm-live-checkbox-checked": {
		borderColor: "var(--lm-text-accent)",
		backgroundColor: "var(--lm-text-accent)",
		backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5l3 3 6-7' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
		backgroundSize: "100% 100%",
	},
	".cm-live-task-done": { color: "var(--lm-text-secondary)" },
	// As tall as the line of source it replaces (the editor's line height), so opening the rule does not move the text around it.
	// Inline, not a block: the widget's buffers on both sides are inline, and a block between them would add a line box above and below.
	".cm-live-rule": {
		display: "inline-block",
		width: "100%",
		height: "1.65em",
		verticalAlign: "top",
		background: "linear-gradient(var(--lm-border-default), var(--lm-border-default)) center / 100% 1px no-repeat",
	},
	".cm-live-link:not(.markdown-file-link)": { color: "var(--lm-text-accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
	".cm-live-h1, .cm-live-h2, .cm-live-h3, .cm-live-h4, .cm-live-h5, .cm-live-h6": {
		fontWeight: "var(--lm-weight-semibold)",
		lineHeight: "1.3",
	},
	".cm-live-h1": { fontSize: "1.7em" },
	".cm-live-h2": { fontSize: "1.35em" },
	".cm-live-h3": { fontSize: "1.15em" },
	".cm-live-h4, .cm-live-h5, .cm-live-h6": { fontSize: "1em" },
});

export const liveClicks = EditorView.domEventHandlers({
	mousedown(event, view) {
		const box = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cm-live-checkbox");
		if (box && event.button === 0 && !view.state.readOnly) {
			// Tick or untick by rewriting the one character between the brackets.
			const at = view.posAtDOM(box);
			if (/^\[[ xX]\]$/.test(view.state.doc.sliceString(at, at + 3))) {
				event.preventDefault();
				const checked = view.state.doc.sliceString(at + 1, at + 2) !== " ";
				view.dispatch({ changes: { from: at + 1, to: at + 2, insert: checked ? " " : "x" } });
				return true;
			}
		}
		if ((!view.state.readOnly && !(event.metaKey || event.ctrlKey)) || event.button !== 0) return false;
		const link = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-href]");
		if (!link?.dataset.href) return false;
		event.preventDefault();
		window.open(link.dataset.href, "_blank", "noopener,noreferrer");
		return true;
	},
});

export const liveLibrary = libraryField;
