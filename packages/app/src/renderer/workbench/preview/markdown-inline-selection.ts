import type { SelectionRange } from "@codemirror/state";
import { Direction, EditorView, RectangleMarker, layer } from "@codemirror/view";

const fillClass = "cm-markdown-inline-selection-fill";
type Origin = { left: number; top: number };
type TextRow = { top: number; bottom: number; selected: DOMRect[] };
type LineSelection = { top: number; bottom: number; markers: RectangleMarker[] };

function textRects(view: EditorView, line: Element, selection: SelectionRange): { all: DOMRect[]; selected: DOMRect[] } {
	const { ownerDocument } = line;
	const walker = ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
	const range = ownerDocument.createRange();
	const all: DOMRect[] = [];
	const selected: DOMRect[] = [];
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		range.selectNodeContents(node);
		const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
		if (!rects.length) continue;
		all.push(...rects);
		const start = view.posAtDOM(node);
		const from = Math.max(0, selection.from - start);
		const to = Math.min(node.length, selection.to - start);
		if (from >= to) continue;
		if (from === 0 && to === node.length) {
			selected.push(...rects);
		} else {
			range.setStart(node, from);
			range.setEnd(node, to);
			for (const rect of range.getClientRects()) if (rect.width > 0) selected.push(rect);
		}
	}
	return { all, selected };
}

function selectionOnLine(view: EditorView, line: Element, selection: SelectionRange, origin: Origin): LineSelection | null {
	const from = view.posAtDOM(line, 0);
	const to = view.posAtDOM(line, line.childNodes.length);
	if (selection.to <= from || selection.from >= to) return null;
	// A list bullet replaces one source character with one glyph. Leave other widgets to the native layer.
	if (line.querySelector('[contenteditable="false"]:not(.cm-live-bullet)')) return null;

	const { all, selected } = textRects(view, line, selection);
	if (!selected.length) return null;
	const rows: TextRow[] = [];
	const rowAt = (rect: DOMRect) => {
		const center = (rect.top + rect.bottom) / 2;
		return rows.find((row) => row.top < center && center < row.bottom);
	};
	for (const rect of all) {
		const row = rowAt(rect);
		if (row) {
			row.top = Math.min(row.top, rect.top);
			row.bottom = Math.max(row.bottom, rect.bottom);
		} else {
			rows.push({ top: rect.top, bottom: rect.bottom, selected: [] });
		}
	}
	rows.sort((a, b) => a.top - b.top);
	for (const rect of selected) rowAt(rect)?.selected.push(rect);

	const bounds = line.getBoundingClientRect();
	// A blank paragraph separator should not stretch the preceding text to the right margin.
	const boundsBelow = selection.to > to && view.state.doc.lineAt(to + 1).text.trim() !== "";
	const boundsAbove = selection.from < from;
	const selectedRows = rows.filter((row) => row.selected.length > 0);
	const directions = view.bidiSpans(view.state.doc.lineAt(from));
	const direction = directions.length === 1 ? directions[0]!.dir : null;
	const wraps = rows.length > 1;
	const markers: RectangleMarker[] = [];
	for (const [index, row] of selectedRows.entries()) {
		const rowIndex = rows.indexOf(row);
		const above = rows[rowIndex - 1];
		const below = rows[rowIndex + 1];
		// Split the gaps at the same positions whether or not the neighboring row is selected.
		const top = above ? (above.bottom + row.top) / 2 : wraps ? bounds.top : row.top;
		const bottom = below ? (row.bottom + below.top) / 2 : wraps ? bounds.bottom : row.bottom;
		const add = (left: number, right: number) => {
			markers.push(new RectangleMarker(fillClass, left - origin.left, top - origin.top, right - left, bottom - top));
		};
		if (direction === null) {
			for (const rect of row.selected) add(rect.left, rect.right);
			continue;
		}
		const before = index > 0 || boundsAbove;
		const after = index < selectedRows.length - 1 || boundsBelow;
		const left = Math.min(...row.selected.map((rect) => rect.left), (direction === Direction.LTR ? before : after) ? bounds.left : Infinity);
		const right = Math.max(...row.selected.map((rect) => rect.right), (direction === Direction.LTR ? after : before) ? bounds.right : -Infinity);
		add(left, right);
	}
	return markers.length ? { top: bounds.top - origin.top, bottom: bounds.bottom - origin.top, markers } : null;
}

function selectionOnBlankLine(view: EditorView, line: Element, selection: SelectionRange, origin: Origin): LineSelection | null {
	const text = view.state.doc.lineAt(view.posAtDOM(line, 0));
	if (text.text.trim() || selection.from > text.from || selection.to <= text.to) return null;
	const bounds = line.getBoundingClientRect();
	const top = bounds.top - origin.top;
	// Use this line's width. The native selection's joining rectangle borrows the first rendered line's padding.
	return {
		top,
		bottom: bounds.bottom - origin.top,
		markers: [new RectangleMarker(fillClass, bounds.left - origin.left, top, bounds.width, bounds.height)],
	};
}

function outsideLines(marker: RectangleMarker, lines: readonly LineSelection[], selectionBottom: number): RectangleMarker[] {
	const result: RectangleMarker[] = [];
	let top = marker.top;
	const bottom = Math.min(top + marker.height, selectionBottom);
	const add = (end: number) => {
		if (end > top) result.push(new RectangleMarker(fillClass, marker.left, top, marker.width, end - top));
	};
	for (const line of lines) {
		if (line.top >= bottom) break;
		if (line.bottom <= top) continue;
		add(line.top);
		top = Math.max(top, line.bottom);
	}
	add(bottom);
	return result;
}

export const markdownInlineSelection = [
	layer({
		class: "cm-markdown-inline-selection",
		above: false,
		update: ({ docChanged, selectionSet, viewportChanged }) => docChanged || selectionSet || viewportChanged,
		markers(view) {
			const selections = view.state.selection.ranges.filter((range) => !range.empty);
			if (!selections.length) return [];
			const lines = new Set([...view.contentDOM.querySelectorAll(".cm-live-code")].map((code) => code.closest(".cm-line")));
			if (!lines.size) return [];
			const blankLines = [...view.contentDOM.querySelectorAll(":scope > .cm-line:not(.cm-live-codeblock)")]
				.filter((line) => !line.textContent?.trim());
			const scroll = view.scrollDOM;
			const box = scroll.getBoundingClientRect();
			const origin = {
				left: (view.textDirection === Direction.LTR ? box.left : box.right - scroll.clientWidth * view.scaleX) - scroll.scrollLeft * view.scaleX,
				top: box.top - scroll.scrollTop * view.scaleY,
			};
			const fills: RectangleMarker[] = [];
			let hasReplacement = false;
			for (const selection of selections) {
				const replacements = [...lines].map((line) => line && selectionOnLine(view, line, selection, origin)).filter((line) => line !== null);
				if (replacements.length) {
					hasReplacement = true;
					for (const line of blankLines) {
						const blank = selectionOnBlankLine(view, line, selection, origin);
						if (blank) replacements.push(blank);
					}
					replacements.sort((a, b) => a.top - b.top);
				}
				// CodeMirror can lend its joining strip into a line whose first position is only the endpoint.
				const end = view.state.doc.lineAt(selection.to);
				const endBlock = replacements.length && selection.to === end.from ? view.lineBlockAt(end.from) : null;
				const bottom = endBlock?.from === end.from ? view.documentTop + endBlock.top - origin.top : Infinity;
				for (const marker of RectangleMarker.forRange(view, fillClass, selection)) fills.push(...outsideLines(marker, replacements, bottom));
				for (const line of replacements) fills.push(...line.markers);
			}
			return hasReplacement ? fills : [];
		},
	}),
	EditorView.theme({
		".cm-markdown-inline-selection": { pointerEvents: "none", zIndex: "-2 !important" },
		[`.${fillClass}`]: { backgroundColor: "var(--markdown-selection-bg)" },
		".cm-scroller:has(> .cm-markdown-inline-selection:not(:empty)) > .cm-selectionLayer > .cm-selectionBackground": { visibility: "hidden" },
	}),
];
