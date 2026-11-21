import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { Direction, EditorView, layer, RectangleMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findWikiLinks } from "@loom/core/references";
import type { MarkdownDropAction, UiSelectionDraft } from "../../../shared/ipc.ts";
import { markdownEmbedLayout, markdownLibraryReference } from "../../../shared/markdown-reference.ts";
import { activeLibraryDrag, draggedAssetIds, endLibraryDrag, hasLibraryDrag, hasOsFileDrag, readLibraryDrag } from "../../assets/asset-drag.ts";
import { insideLiteral, liveLibrary, markdownFilePath } from "./live-markdown.ts";
import { tableRange } from "./live-table.ts";

type DropPoint = { position: number; placement: "inline" | "beforeBlock" | "documentEnd"; side: -1 | 1 };
type DroppedFile = Pick<UiSelectionDraft, "path" | "assetType">;
export interface MarkdownDropHost {
	chooseDropAction(nativeFilenames?: readonly string[]): Promise<MarkdownDropAction | null>;
	importFiles(files: readonly File[]): Promise<UiSelectionDraft[]>;
	onDropError(error: unknown): void;
}

const literalBlocks = new Set(["CodeBlock", "FencedCode", "HTMLBlock", "Table"]);
const inlineReferences = new Set(["InlineCode", "Link", "Image", "Autolink"]);

function documentBottom(view: EditorView): number {
	return view.documentTop + view.lineBlockAt(view.state.doc.length).bottom;
}

const setHoverPoint = StateEffect.define<DropPoint | null>();
const hoverPoint = StateField.define<DropPoint | null>({
	create: () => null,
	update(point, transaction) {
		if (transaction.state.readOnly) return null;
		for (const effect of transaction.effects) {
			if (effect.is(setHoverPoint)) return effect.value;
		}
		if (!point || !transaction.docChanged) return point;
		const position = transaction.changes.mapPos(point.position, 1);
		return { ...point, position: point.placement === "beforeBlock" ? transaction.state.doc.lineAt(position).from : position };
	},
});

const dropCaret = layer({
	above: true,
	update: (update) => update.startState.field(hoverPoint) !== update.state.field(hoverPoint),
	markers(view) {
		const point = view.state.field(hoverPoint);
		if (!point) return [];
		const markersAt = (position: number, side: -1 | 1) =>
			RectangleMarker.forRange(view, "cm-dropCursor", EditorSelection.cursor(position, side));
		if (point.placement === "documentEnd") {
			const line = view.state.doc.lineAt(point.position);
			if (!line.text.trim()) return markersAt(line.from, 1);
			const content = view.contentDOM.getBoundingClientRect();
			const scroll = view.scrollDOM.getBoundingClientRect();
			const left = view.textDirection === Direction.LTR
				? content.left - scroll.left
				: content.right - (scroll.right - view.scrollDOM.clientWidth * view.scaleX);
			return [new RectangleMarker(
				"cm-dropCursor",
				left + view.scrollDOM.scrollLeft * view.scaleX,
				documentBottom(view) - scroll.top + view.scrollDOM.scrollTop * view.scaleY,
				null,
				view.defaultLineHeight,
			)];
		}
		const markers = markersAt(point.position, point.side);
		const marker = markers[0];
		// A rendered block can report its entire height, or just the edge before it.
		if (point.placement === "beforeBlock" && marker) {
			return [new RectangleMarker("cm-dropCursor", marker.left, marker.top, null, view.defaultLineHeight)];
		}
		if (!marker?.height) {
			// Hidden Markdown symbols have zero font size. Measure at their visible edge while keeping the drop position.
			const { node } = view.domAtPos(point.position, point.side);
			const hidden = (node instanceof Element ? node : node.parentElement)?.closest(".cm-live-hidden");
			if (hidden) {
				const before = view.posAtDOM(hidden);
				const after = view.posAtDOM(hidden, hidden.childNodes.length);
				const preferred = point.side < 0 ? markersAt(before, -1) : markersAt(after, 1);
				if (preferred[0]?.height) return preferred;
				return point.side < 0 ? markersAt(after, 1) : markersAt(before, -1);
			}
		}
		return markers;
	},
});

const dropCaretTheme = EditorView.baseTheme({
	"&.cm-markdown-file-hover .cm-cursorLayer": { visibility: "hidden" },
});

function dropPoint(view: EditorView, event: DragEvent): DropPoint {
	const doc = view.state.doc;
	const table = event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-live-table") : null;
	const range = table && tableRange(view, table);
	if (range) return { position: doc.lineAt(range.from).from, placement: "beforeBlock", side: 1 };

	const { pos: at, assoc } = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
	const tree = syntaxTree(view.state);
	let position = at;
	let blockStart = at;
	let beforeBlock = false;
	for (let node = tree.resolveInner(at, -1); node.parent; node = node.parent) {
		if (literalBlocks.has(node.name)) beforeBlock = true;
		if (inlineReferences.has(node.name)) position = node.to;
		blockStart = node.from;
	}
	if (beforeBlock) return { position: doc.lineAt(blockStart).from, placement: "beforeBlock", side: 1 };
	if (at === doc.length && event.clientY >= documentBottom(view)) {
		return { position: at, placement: "documentEnd", side: 1 };
	}

	// Lezer sees the inner brackets as a Markdown link. Include the outer brackets when snapping past a wiki link.
	const line = doc.lineAt(at);
	const offset = at - line.from;
	const wiki = findWikiLinks(line.text).find((link) => link.from < offset && offset < link.end);
	if (wiki && !insideLiteral(tree, line.from + wiki.from, line.from + wiki.end)) {
		position = Math.max(position, line.from + wiki.end);
	}
	return { position, placement: "inline", side: position === at ? assoc : -1 };
}

function insertReferences(view: EditorView, point: DropPoint, files: readonly DroppedFile[], action: MarkdownDropAction): void {
	if (view.state.readOnly) return;
	const source = markdownFilePath(view.state);
	if (!source) return;
	const references = new Map<string, string>();
	let standalone = false;
	for (const { path, assetType } of files) {
		const layout = action === "embed" && path !== source ? markdownEmbedLayout(assetType, path) : undefined;
		if (layout === "block") standalone = true;
		references.set(path, (layout ? "!" : "") + markdownLibraryReference(source, path));
	}
	const text = [...references.values()].join(standalone ? "\n\n" : " ");
	if (!text) return;
	const { doc } = view.state;
	const line = doc.lineAt(point.position);
	let position = point.position;
	let prefix: string;
	let suffix: string;
	if (point.placement === "beforeBlock") {
		position = line.from;
		prefix = line.number > 1 && doc.line(line.number - 1).text.trim() ? "\n" : "";
		suffix = "\n\n";
	} else if (standalone) {
		// Players need their own paragraphs. Keep the source line intact when the drop lands inside it.
		position = line.to;
		const needsNewline = line.length > 0 || line.number > 1 && doc.line(line.number - 1).text.trim();
		prefix = line.text.trim() ? "\n\n" : needsNewline ? "\n" : "";
		suffix = line.number < doc.lines && doc.line(line.number + 1).text.trim() ? "\n" : "";
	} else if (point.placement === "documentEnd") {
		const blank = !line.text.trim();
		position = blank ? line.from : line.to;
		prefix = blank ? "" : "\n";
		suffix = "";
	} else {
		prefix = /\S/.test(doc.sliceString(Math.max(0, position - 1), position)) ? " " : "";
		suffix = /\S/.test(doc.sliceString(position, Math.min(doc.length, position + 1))) ? " " : "";
	}
	view.dispatch({
		changes: { from: position, insert: prefix + text + suffix },
		selection: { anchor: position + prefix.length + text.length },
		annotations: isolateHistory.of("full"),
		userEvent: "input.drop",
		scrollIntoView: true,
	});
	view.focus();
}

export function markdownFileDrop(host: MarkdownDropHost) {
	const events = ViewPlugin.define((view) => {
		const pending = new Set<DropPoint>();
		let drops = Promise.resolve();

		function queueDrop(
			point: DropPoint,
			choose: () => MarkdownDropAction | Promise<MarkdownDropAction | null>,
			load: () => DroppedFile[] | Promise<DroppedFile[]>,
		): void {
			pending.add(point);
			const active = () => pending.has(point) && !view.state.readOnly;
			drops = drops.then(async () => {
				try {
					if (!active()) return;
					const action = await choose();
					if (!action || !active()) return;
					const files = await load();
					if (active()) insertReferences(view, point, files, action);
				} catch (error) {
					if (active()) host.onDropError(error);
				} finally {
					pending.delete(point);
				}
			});
		}

		function setCaret(point: DropPoint | null): void {
			const current = view.state.field(hoverPoint);
			if (current?.position === point?.position && current?.placement === point?.placement && current?.side === point?.side) return;
			view.dispatch({ effects: setHoverPoint.of(point) });
		}

		function dragend(): void { setCaret(null); }

		function dragleave(event: DragEvent): void {
			if (!(event.relatedTarget instanceof Node) || !view.scrollDOM.contains(event.relatedTarget)) setCaret(null);
		}

		function dragover(event: DragEvent): void {
			const transfer = event.dataTransfer;
			if (!transfer) return;
			const libraryDrag = hasLibraryDrag(transfer);
			if (!libraryDrag && !hasOsFileDrag(transfer)) return;
			event.preventDefault();
			const item = libraryDrag ? activeLibraryDrag() : null;
			const canDrop = !view.state.readOnly && (!item || draggedAssetIds(item).length > 0);
			transfer.dropEffect = canDrop ? "copy" : "none";
			setCaret(canDrop ? dropPoint(view, event) : null);
		}

		function drop(event: DragEvent): void {
			const transfer = event.dataTransfer;
			if (!transfer) return;
			const libraryDrag = hasLibraryDrag(transfer);
			if (!libraryDrag && !hasOsFileDrag(transfer)) return;
			event.preventDefault();
			event.stopPropagation();
			const hovered = view.state.field(hoverPoint);
			setCaret(null);
			if (view.state.readOnly) return;
			// Insert at the last advertised position even if the mouse moved after the last dragover.
			const point = hovered ? { ...hovered } : dropPoint(view, event);
			if (libraryDrag) {
				try {
					const ids = draggedAssetIds(readLibraryDrag(transfer) ?? null);
					if (!ids.length) return;
					const assets = () => {
						const lookup = view.state.field(liveLibrary, false)?.lookup;
						return ids.flatMap((id) => {
							const asset = lookup?.byId(id);
							return asset ? [{ path: asset.relativePath, assetType: asset.type }] : [];
						});
					};
					queueDrop(point, () => {
						const source = markdownFilePath(view.state);
						return assets().some(({ path, assetType }) => path !== source && markdownEmbedLayout(assetType, path))
							? host.chooseDropAction() : "link";
					}, assets);
				} catch (error) {
					host.onDropError(error);
				} finally {
					endLibraryDrag();
				}
				return;
			}

			const files = [...transfer.files];
			if (!files.length) return;
			queueDrop(point, () => host.chooseDropAction(files.map((file) => file.name)), () => host.importFiles(files));
		}

		// Listen in capture so table widgets and CodeMirror's own text-file drop cannot consume file drops.
		view.scrollDOM.addEventListener("dragover", dragover, true);
		view.scrollDOM.addEventListener("dragleave", dragleave, true);
		view.scrollDOM.addEventListener("drop", drop, true);
		view.dom.ownerDocument.addEventListener("dragend", dragend, true);
		return {
			update(update: ViewUpdate) {
				if (!update.docChanged) return;
				for (const point of pending) point.position = update.changes.mapPos(point.position, 1);
			},
			destroy() {
				pending.clear();
				view.scrollDOM.removeEventListener("dragover", dragover, true);
				view.scrollDOM.removeEventListener("dragleave", dragleave, true);
				view.scrollDOM.removeEventListener("drop", drop, true);
				view.dom.ownerDocument.removeEventListener("dragend", dragend, true);
			},
		};
	});
	return [
		hoverPoint, dropCaret, dropCaretTheme, events,
		EditorView.editorAttributes.compute([hoverPoint], (state) => ({
			class: state.field(hoverPoint) ? "cm-markdown-file-hover" : "",
		})),
	];
}
