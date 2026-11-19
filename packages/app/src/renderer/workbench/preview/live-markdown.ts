import { syntaxTree } from "@codemirror/language";
import { Facet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Asset } from "@loom/core";
import { createAssetLookup, matchWikiLink, resolveLinkTarget, resolveWikiTarget, type AssetLookup } from "@loom/core/references";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { anchorOf } from "./heading-key.ts";
import { matchBlockMath, matchInlineMath, renderMath } from "./math.ts";
import { enterTable, TableWidget, type TableHooks } from "./live-table.ts";
import { hydrateMermaid } from "./mermaid.ts";
import { parseTable } from "./table.ts";

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

const tableHooksFacet = Facet.define<TableHooks, TableHooks | null>({ combine: (values) => values[0] ?? null });
/** What the tables drawn in the editor need from the editor's owner: saving, opening a link, and their labels. */
export const liveTables = (hooks: TableHooks) => tableHooksFacet.of(hooks);

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
	toDOM(view: EditorView): HTMLElement {
		const image = document.createElement("img");
		image.className = "cm-live-image";
		image.src = this.src;
		image.alt = this.alt;
		image.draggable = false;
		enterOnClick(image, view);
		remeasureOnResize(image, view);
		return image;
	}
	destroy(dom: HTMLElement): void {
		stopRemeasuring(dom);
	}
}

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

/** A checkbox in place of `[ ]` or `[x]`. A click is handled by {@link liveClicks}, which edits the text. */
class CheckboxWidget extends WidgetType {
	readonly checked: boolean;
	constructor(checked: boolean) {
		super();
		this.checked = checked;
	}
	eq(other: CheckboxWidget): boolean {
		return other.checked === this.checked;
	}
	toDOM(): HTMLElement {
		const box = document.createElement("span");
		box.className = this.checked ? "cm-live-checkbox cm-live-checkbox-checked" : "cm-live-checkbox";
		box.setAttribute("role", "checkbox");
		box.setAttribute("aria-checked", String(this.checked));
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
		if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
		event.preventDefault();
		view.dispatch({ selection: { anchor: view.posAtDOM(dom) }, scrollIntoView: false });
		view.focus();
	});
}

/** A formula, inline or on its own, rendered by KaTeX. */
class MathWidget extends WidgetType {
	readonly tex: string;
	readonly display: boolean;
	constructor(tex: string, display: boolean) {
		super();
		this.tex = tex;
		this.display = display;
	}
	eq(other: MathWidget): boolean {
		return other.tex === this.tex && other.display === this.display;
	}
	toDOM(view: EditorView): HTMLElement {
		const node = document.createElement(this.display ? "div" : "span");
		node.className = this.display ? "cm-live-math cm-live-math-block" : "cm-live-math";
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
	readonly drawn: boolean;
	constructor(source: string) {
		super();
		this.source = source;
		this.drawn = drawnDiagrams.has(source);
	}
	eq(other: MermaidWidget): boolean {
		return other.source === this.source && other.drawn === this.drawn;
	}
	get estimatedHeight(): number {
		return drawnDiagrams.get(this.source)?.height ?? 160;
	}
	toDOM(view: EditorView): HTMLElement {
		const node = document.createElement("div");
		node.className = "cm-live-mermaid";
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
};

/** True when any selection range touches `from..to`, edges included, so a cursor next to a symbol reveals it. */
function touched(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

export function liveDecorations(state: EditorState, from = 0, to = state.doc.length): DecorationSet {
	const found: Range<Decoration>[] = [];
	const line = (position: number, className: string) => found.push(Decoration.line({ class: className }).range(state.doc.lineAt(position).from));

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
				if (task) found.push(hidden.range(node.from, Math.min(task.from, node.to + 1)));
				else found.push(bullet.range(node.from, node.to));
				return;
			}
			if (node.name === "TaskMarker") {
				const written = state.doc.sliceString(node.from, node.to);
				if (!/^\[[ xX]\]$/.test(written)) return;
				found.push(Decoration.line({ class: written === "[ ]" ? "cm-live-task" : "cm-live-task cm-live-task-done" }).range(state.doc.lineAt(node.from).from));
				if (!onLine(node.from)) found.push(Decoration.replace({ widget: new CheckboxWidget(written !== "[ ]") }).range(node.from, node.to));
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
					at = text.to + 1;
				}
				return false;
			}
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
	for (const [start, quote] of quotes) {
		// One bar for each level of nesting, drawn as a background so the line's own text stays untouched.
		const bars = Array.from({ length: quote.depth }, (_, level) => `linear-gradient(var(--lm-border-strong), var(--lm-border-strong)) ${level * 16}px 0 / 3px 100% no-repeat`).join(", ");
		found.push(Decoration.line({ class: "cm-live-quote", attributes: { style: `padding-left:${quote.depth * 16}px;background:${bars}` } }).range(start));
		if (!onLine(start)) for (const mark of quote.marks) found.push(hidden.range(mark.from, mark.to));
	}
	wikiLinks(state, from, to, found);
	markdownImages(state, from, to, found);
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
		if (fence && !reveal) {
			const start = Math.max(text.from, number === first ? node.from : marks[marks.length - 1].from);
			if (start < text.to) found.push(hidden.range(start, text.to));
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
			if (touched(state, start, end)) {
				found.push(Decoration.mark({ class: "cm-live-math-source" }).range(start, end));
			} else {
				found.push(Decoration.replace({ widget: new MathWidget(match.tex, match.display) }).range(start, end));
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
				if (math && !touched(state, node.from, node.to)) {
					builder.add(node.from, node.to, Decoration.replace({ widget: new MathWidget(math.tex, true), block: true }));
				}
			} else if (node.name === "Table" && node.node.parent?.name === "Document") {
				const text = state.doc.sliceString(node.from, node.to);
				// A selection that runs over a table leaves it drawn. Only a caret inside it, which cannot be
				// seen in a drawn table, brings the source back.
				const caretInside = state.selection.ranges.some((range) => range.empty && range.from >= node.from && range.to <= node.to);
				if (!caretInside && parseTable(text)) {
					const context = state.field(libraryField, false) ?? null;
					const widget = new TableWidget(text, context, (view) => view.state.facet(tableHooksFacet), redrawBlocks);
					builder.add(node.from, node.to, Decoration.replace({ widget, block: true }));
				}
			} else if (node.name === "FencedCode" && node.node.parent?.name === "Document") {
				const info = node.node.getChild("CodeInfo");
				const language = info ? state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0]?.toLowerCase() : "";
				const code = node.node.getChild("CodeText");
				if (language === "mermaid" && code && node.node.getChildren("CodeMark").length > 1 && !touched(state, node.from, node.to)) {
					builder.add(node.from, node.to, Decoration.replace({ widget: new MermaidWidget(state.doc.sliceString(code.from, code.to)), block: true }));
				}
			}
			return false;
		},
	});
	return builder.finish();
}

/** Draws {@link liveBlockDecorations}. Add it next to {@link liveMarkdown}. */
export const liveBlocks = StateField.define<DecorationSet>({
	create: (state) => liveBlockDecorations(state),
	update(value, transaction) {
		const treeChanged = syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
		const redraw = transaction.effects.some((effect) => effect.is(redrawBlocks));
		return transaction.docChanged || transaction.selection || treeChanged || redraw ? liveBlockDecorations(transaction.state) : value;
	},
	provide: (field) => EditorView.decorations.from(field),
});

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
		view.state.field(liveBlocks).between(from, to, (blockFrom, blockTo, decoration) => {
			// Only a block the move passes over; one that holds the start or the landing is already being edited.
			if (blockFrom < from || blockTo > to) return;
			const closer = !nearest || (direction === "down" ? blockFrom < nearest.from : blockTo > nearest.to);
			if (closer) nearest = { from: blockFrom, to: blockTo, table: decoration.spec.widget instanceof TableWidget };
		});
		const block = nearest as { from: number; to: number; table: boolean } | null;
		if (!block) return false;
		if (block.table && enterTable(view, block.from, direction === "up" ? "last" : "first")) return true;
		view.dispatch({ selection: { anchor: direction === "up" ? block.to : block.from }, scrollIntoView: true });
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
		view.state.field(liveBlocks).between(Math.min(start, landing), Math.max(start, landing), (from, to, decoration) => {
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
	".cm-live-codeblock": {
		backgroundColor: "var(--lm-surface-hover)",
		fontFamily: "var(--lm-font-mono)",
		fontSize: "0.88em",
		padding: "0 14px",
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
	".cm-live-table": { position: "relative", padding: "0.4em 22px 18px 0" },
	".cm-live-table-scroll": { overflowX: "auto" },
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
	// Inline code in a cell looks as it does in the text.
	".cm-live-table code": {
		padding: "0.1em 0.35em",
		borderRadius: "var(--lm-radius-sm)",
		backgroundColor: "var(--lm-surface-hover)",
		fontFamily: "var(--lm-font-mono)",
		fontSize: "0.86em",
	},
	".cm-live-table a": { color: "var(--lm-text-accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
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
	".cm-live-table-add-row": { left: "0", right: "22px", bottom: "0", height: "18px" },
	".cm-live-table-add-column": { top: "0", right: "0", bottom: "22px", width: "18px" },
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
	".cm-live-rule": { height: "0", margin: "0.6em 0", borderTop: "1px solid var(--lm-border-default)" },
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
		const box = (event.target as HTMLElement | null)?.closest<HTMLElement>(".cm-live-checkbox");
		if (box && event.button === 0) {
			// Tick or untick by rewriting the one character between the brackets.
			const at = view.posAtDOM(box);
			if (/^\[[ xX]\]$/.test(view.state.doc.sliceString(at, at + 3))) {
				event.preventDefault();
				const checked = view.state.doc.sliceString(at + 1, at + 2) !== " ";
				view.dispatch({ changes: { from: at + 1, to: at + 2, insert: checked ? " " : "x" } });
				return true;
			}
		}
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
