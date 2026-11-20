import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { EditorView, layer, RectangleMarker, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { UiSelectionDraft } from "../../../shared/ipc.ts";
import { activeLibraryDrag, draggedAssetIds, endLibraryDrag, hasLibraryDrag, hasOsFileDrag, readLibraryDrag } from "../../assets/asset-drag.ts";
import { liveLibrary, markdownFilePath } from "./live-markdown.ts";
import { tableRange } from "./live-table.ts";
import { markdownLibraryReference } from "./markdown-reference.ts";

type DropPoint = { position: number; beforeBlock: boolean; side: -1 | 1 };
type DropHost = {
	importFiles(files: readonly File[]): Promise<UiSelectionDraft[]>;
	onDropError(error: unknown): void;
};

const literalBlocks = new Set(["CodeBlock", "FencedCode", "HTMLBlock", "Table"]);
const inlineReferences = new Set(["InlineCode", "Link", "Image", "Autolink"]);

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
		return { ...point, position: point.beforeBlock ? transaction.state.doc.lineAt(position).from : position };
	},
});

const dropCaret = layer({
	above: true,
	update: (update) => update.startState.field(hoverPoint) !== update.state.field(hoverPoint),
	markers(view) {
		const point = view.state.field(hoverPoint);
		if (!point) return [];
		const range = EditorSelection.cursor(point.position, point.side);
		const markers = RectangleMarker.forRange(view, "cm-dropCursor", range);
		const marker = markers[0];
		// A rendered block can report its entire height, or just the edge before it.
		if (point.beforeBlock && marker) {
			return [new RectangleMarker("cm-dropCursor", marker.left, marker.top, null, view.defaultLineHeight)];
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
	if (range) return { position: doc.lineAt(range.from).from, beforeBlock: true, side: 1 };

	const { pos: at, assoc } = view.posAndSideAtCoords({ x: event.clientX, y: event.clientY }, false);
	let position = at;
	let blockStart = at;
	let beforeBlock = false;
	for (let node = syntaxTree(view.state).resolveInner(at, -1); node.parent; node = node.parent) {
		if (literalBlocks.has(node.name)) beforeBlock = true;
		if (inlineReferences.has(node.name)) position = node.to;
		blockStart = node.from;
	}
	return beforeBlock
		? { position: doc.lineAt(blockStart).from, beforeBlock, side: 1 }
		: { position, beforeBlock, side: position === at ? assoc : -1 };
}

function insertReferences(view: EditorView, point: DropPoint, paths: Iterable<string>): void {
	if (view.state.readOnly) return;
	const source = markdownFilePath(view.state);
	if (!source) return;
	const links = [...new Set(paths)].map((path) => markdownLibraryReference(source, path)).join(" ");
	if (!links) return;
	const { doc } = view.state;
	const { beforeBlock } = point;
	const position = beforeBlock ? doc.lineAt(point.position).from : point.position;
	const before = doc.sliceString(Math.max(0, position - 1), position);
	const after = position < doc.length ? doc.sliceString(position, position + 1) : "";
	const prefix = beforeBlock
		? position > 0 && doc.lineAt(position - 1).text.trim() ? "\n" : ""
		: /\S/.test(before) ? " " : "";
	const suffix = beforeBlock ? "\n\n" : /\S/.test(after) ? " " : "";
	view.dispatch({
		changes: { from: position, insert: prefix + links + suffix },
		selection: { anchor: position + prefix.length + links.length },
		annotations: isolateHistory.of("full"),
		userEvent: "input.drop",
		scrollIntoView: true,
	});
	view.focus();
}

export function markdownFileDrop(host: DropHost) {
	const events = ViewPlugin.define((view) => {
		const pending = new Set<DropPoint>();
		let imports = Promise.resolve();

		function setCaret(point: DropPoint | null): void {
			const current = view.state.field(hoverPoint);
			if (current?.position === point?.position && current?.beforeBlock === point?.beforeBlock && current?.side === point?.side) return;
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
					const lookup = view.state.field(liveLibrary, false)?.lookup;
					const ids = draggedAssetIds(readLibraryDrag(transfer) ?? null);
					insertReferences(view, point, ids.flatMap((id) => {
						const asset = lookup?.byId(id);
						return asset ? [asset.relativePath] : [];
					}));
				} catch (error) {
					host.onDropError(error);
				} finally {
					endLibraryDrag();
				}
				return;
			}

			const files = [...transfer.files];
			if (!files.length) return;
			pending.add(point);
			imports = imports.then(async () => {
				if (!pending.has(point)) return;
				try {
					const assets = await host.importFiles(files);
					if (pending.has(point)) insertReferences(view, point, assets.map((asset) => asset.path));
				} catch (error) {
					if (pending.has(point)) host.onDropError(error);
				} finally {
					pending.delete(point);
				}
			});
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
