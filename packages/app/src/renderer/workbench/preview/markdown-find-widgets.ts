import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import { StateField } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { parseTable } from "./table.ts";

type Match = { from: number; to: number; current: boolean };
type Marks = Map<HTMLElement, boolean>;

const widgetSelector = ".cm-live-table, .cm-live-math, .cm-live-mermaid";

export const searchSelection = StateField.define<boolean>({
	create: () => false,
	update(value, transaction) {
		if (!searchPanelOpen(transaction.state)) return false;
		if (transaction.selection) return transaction.isUserEvent("select.search") || transaction.isUserEvent("input.replace");
		return value && !transaction.docChanged;
	},
});

function mark(marks: Marks, element: HTMLElement, current: boolean): void {
	if (current || !marks.has(element)) marks.set(element, current);
}

/** A hit inside one cell belongs to that cell. A hit on table syntax belongs to the table. */
function markTable(marks: Marks, element: HTMLElement, source: string, from: number, hits: Match[]): void {
	const table = parseTable(source);
	let index = 0;
	if (table) {
		for (const cell of element.querySelectorAll<HTMLElement>("[data-row][data-column]")) {
			if (index === hits.length) break;
			const bounds = table.rows[Number(cell.dataset.row)]?.cells[Number(cell.dataset.column)];
			if (!bounds) continue;
			while (index < hits.length && hits[index].from < from + bounds.from) {
				mark(marks, element, hits[index++].current);
			}
			while (index < hits.length && hits[index].to <= from + bounds.to) {
				mark(marks, cell, hits[index++].current);
			}
		}
	}
	for (; index < hits.length; index++) mark(marks, element, hits[index].current);
}

function collectMarks(view: EditorView): Marks {
	const marks: Marks = new Map();
	const { state, contentDOM } = view;
	const query = getSearchQuery(state);
	if (!query.valid || !searchPanelOpen(state)) return marks;
	const widgets = Array.from(contentDOM.querySelectorAll<HTMLElement>(widgetSelector), (element) => {
		const from = view.posAtDOM(element);
		return { element, from, to: from + Number(element.dataset.length) };
	}).filter(({ from, to }) => from < view.viewport.to && to > view.viewport.from);
	if (!widgets.length) return marks;

	// Include the source of the drawn widgets, which CodeMirror omits from visibleRanges.
	const margin = query.regexp ? 250 : query.search.length;
	const from = state.doc.lineAt(Math.max(0, widgets[0].from - margin)).from;
	const to = state.doc.lineAt(Math.min(state.doc.length, widgets[widgets.length - 1].to + margin)).to;
	const matches: Match[] = [];
	const cursor = query.getCursor(state, from, to);
	for (let match = cursor.next(); !match.done; match = cursor.next()) {
		const { from, to } = match.value;
		matches.push({ from, to, current: state.selection.ranges.some((range) => range.from === from && range.to === to) });
	}

	let index = 0;
	for (const { element, from, to } of widgets) {
		while (index < matches.length && (matches[index].to < from || (matches[index].to === from && matches[index].from < from))) index++;
		let end = index;
		while (end < matches.length && matches[end].from < to) end++;
		if (end === index) continue;
		const hits = matches.slice(index, end);
		if (element.classList.contains("cm-live-table")) markTable(marks, element, state.sliceDoc(from, to), from, hits);
		else mark(marks, element, hits.some((hit) => hit.current));
	}
	return marks;
}

/** Mirrors CodeMirror's source matches onto widgets that replace the source in live and reading modes. */
export const markdownFindWidgets = ViewPlugin.fromClass(class {
	private marks: Marks = new Map();

	constructor(view: EditorView) {
		this.refresh(view);
	}

	update(update: ViewUpdate): void {
		if (update.viewportChanged || update.transactions.length) this.refresh(update.view);
	}

	private refresh(view: EditorView): void {
		if (!this.marks.size && (!searchPanelOpen(view.state) || !getSearchQuery(view.state).valid)) return;
		// Measure after CodeMirror has updated the widget DOM, including async Mermaid redraws.
		view.requestMeasure({
			key: this,
			read: () => collectMarks(view),
			write: (next) => {
				for (const element of this.marks.keys()) {
					if (!next.has(element)) element.classList.remove("cm-live-find-match", "cm-live-find-current");
				}
				for (const [element, current] of next) {
					element.classList.add("cm-live-find-match");
					element.classList.toggle("cm-live-find-current", current);
				}
				this.marks = next;
			},
		});
	}
});
