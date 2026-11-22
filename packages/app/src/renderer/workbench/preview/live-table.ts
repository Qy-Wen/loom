import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import type { StateEffectType } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import type { AssetLookup } from "@loom/core/references";
import { EMBED_IMAGE_SELECTOR, EMBED_LINK_SELECTOR } from "./embed-renderers.ts";
import { pressedReference } from "./live-reference.ts";
import { renderInlineMarkdown } from "./markdown.ts";
import type { EditorClipboardAction, MarkdownContextAction, TableContextAction, TableContextState } from "../../../shared/ipc.ts";
import { appendColumn, appendRow, cellChange, cellTexts, clearCells, escapeCell, insertColumn, insertRow, parseTable, moveColumn, moveRow, rectText, removeColumn, pasteCells, removeRow, setAlign, type CellRect, type ParsedTable, type TableAlign } from "./table.ts";

/**
 * A table drawn as a table, with cells that are edited in place. Every edit is written back as a change to that
 * one cell's text, so the alignment spaces and everything else in the table stay as they were.
 */

/** What a table needs from the editor around it. */
export interface TableHooks {
	/** Opens a library file from a link in a cell. */
	openAsset(assetId: string, anchor: string | undefined): void;
	/** Saves now. A cell is not the editor's own text box, so the editor's key bindings do not see it. */
	save(): void;
	/** Asks the window for the table's context menu; resolves with what was chosen, or null. */
	chooseAction(state: TableContextState): Promise<TableContextAction | null>;
	chooseEmbedAction(readOnly: boolean): Promise<MarkdownContextAction | null>;
	clipboard(action: EditorClipboardAction): Promise<void>;
	labels: { addRow: string; addColumn: string; moveRow: string; moveColumn: string };
}

export interface TableContext {
	fromRelativePath: string;
	lookup: AssetLookup;
}

interface Shown {
	text: string;
	context: TableContext | null;
	rows: number;
	columns: number;
	aligns: string;
	readOnly: boolean;
	observer: ResizeObserver | null;
	lastHeight: number;
}

const shown = new WeakMap<HTMLElement, Shown>();

/** Heights of drawn tables by their text. CodeMirror measures a block widget once, so a change has to be handed to it. */
const heights = new Map<string, number>();
const MAX_HEIGHTS = 100;

// Before a table is drawn, allow for one text line plus padding and borders per row.
const ESTIMATED_ROW_HEIGHT = 38;
const TABLE_PADDING_AND_BORDER = 37;

/** A cell to put the caret in once the table around it has been rebuilt (a row or a column was added). */
let pendingFocus: { from: number; row: number; column: number } | null = null;

export class TableWidget extends WidgetType {
	readonly text: string;
	readonly context: TableContext | null;
	readonly height: number | undefined;
	readonly readOnly: boolean;
	private readonly rowCount: number;
	private readonly hooks: (view: EditorView) => TableHooks | null;
	private readonly redraw: StateEffectType<null>;
	constructor(text: string, rowCount: number, context: TableContext | null, hooks: (view: EditorView) => TableHooks | null, redraw: StateEffectType<null>, readOnly = false) {
		super();
		this.text = text;
		this.rowCount = rowCount;
		this.context = context;
		this.height = heights.get(text);
		this.hooks = hooks;
		this.redraw = redraw;
		this.readOnly = readOnly;
	}
	eq(other: TableWidget): boolean {
		return other.text === this.text && other.context === this.context && other.height === this.height && other.readOnly === this.readOnly;
	}

	get estimatedHeight(): number {
		return this.height ?? (TABLE_PADDING_AND_BORDER + this.rowCount * ESTIMATED_ROW_HEIGHT);
	}

	toDOM(view: EditorView): HTMLElement {
		const table = parseTable(this.text)!;
		const wrap = document.createElement("div");
		wrap.className = "cm-live-table";
		// Focusable, so that the keys go to the table while a block of cells is picked and no cell holds the caret.
		wrap.tabIndex = -1;
		// How much of the document the table covers, which tells a selection that spans it from one that does not.
		wrap.dataset.length = String(this.text.length);
		const scroll = document.createElement("div");
		scroll.className = "cm-live-table-scroll";
		const element = document.createElement("table");
		const head = element.createTHead();
		const body = element.createTBody();
		table.rows.forEach((row, rowIndex) => {
			const line = (rowIndex === 0 ? head : body).insertRow();
			for (let column = 0; column < table.columns; column++) {
				const cell = document.createElement(rowIndex === 0 ? "th" : "td");
				cell.contentEditable = this.readOnly ? "false" : "plaintext-only";
				if (this.readOnly) cell.tabIndex = 0;
				cell.spellcheck = false;
				cell.dataset.row = String(rowIndex);
				cell.dataset.column = String(column);
				if (table.aligns[column]) cell.style.textAlign = table.aligns[column];
				showCell(cell, row.cells[column]?.text ?? "", this.context);
				this.listen(cell, wrap, view);
				line.append(cell);
			}
		});
		scroll.append(element);
		// The space around the cells is part of the table. A click there is not on the text beside it, and left to the
		// browser it would put the caret at the table's edge, which turns the table into its source.
		wrap.addEventListener("mousedown", (event) => {
			// The path is taken as the event was sent: a cell that took the focus has already swapped its content for
			// its source, and the element that was clicked is no longer in the page to be asked.
			const onCell = event.composedPath().some((node) => node instanceof HTMLElement && node.matches("th, td, button"));
			if (view.state.readOnly || event.button !== 0 || onCell) return;
			event.preventDefault();
			const rows = Array.from(wrap.querySelectorAll("tr"));
			const rect = wrap.getBoundingClientRect();
			const line = rows[event.clientY < rect.top + rect.height / 2 ? 0 : rows.length - 1];
			const cells = Array.from(line?.cells ?? []);
			const hit = cells.find((cell) => event.clientX < cell.getBoundingClientRect().right) ?? cells[cells.length - 1];
			if (hit) focusCell(wrap, Number(hit.dataset.row), Number(hit.dataset.column), "end");
		});
		this.listenPicked(wrap, view);
		wrap.append(scroll);
		if (!this.readOnly) {
			wrap.append(this.addButton("cm-live-table-add-row", this.hooks(view)?.labels.addRow ?? "", view, wrap, "row"), this.addButton("cm-live-table-add-column", this.hooks(view)?.labels.addColumn ?? "", view, wrap, "column"));
			this.attachHandles(view, wrap, scroll, element);
		}
		const state: Shown = { text: this.text, context: this.context, rows: table.rows.length, columns: table.columns, aligns: table.aligns.join(","), readOnly: this.readOnly, observer: null, lastHeight: 0 };
		shown.set(wrap, state);
		if (typeof ResizeObserver !== "undefined") {
			state.observer = new ResizeObserver(() => {
				const height = Math.round(wrap.getBoundingClientRect().height);
				if (!height || height === state.lastHeight) return;
				state.lastHeight = height;
				if (heights.get(state.text) === height) return;
				if (heights.size >= MAX_HEIGHTS) heights.delete(heights.keys().next().value!);
				heights.set(state.text, height);
				if (wrap.isConnected) view.dispatch({ effects: this.redraw.of(null) });
			});
			state.observer.observe(wrap);
		}
		requestAnimationFrame(() => {
			if (view.state.readOnly || !pendingFocus || !wrap.isConnected) return;
			const range = tableRange(view, wrap);
			if (range?.from !== pendingFocus.from) return;
			const { row, column } = pendingFocus;
			pendingFocus = null;
			focusCell(wrap, row, column, "start");
		});
		return wrap;
	}

	/** Carries an edit made elsewhere into a table that is already drawn, so the cell being typed in keeps its caret. */
	updateDOM(dom: HTMLElement, view: EditorView): boolean {
		const state = shown.get(dom);
		const table = parseTable(this.text);
		if (!state || !table || this.readOnly !== state.readOnly || table.rows.length !== state.rows || table.columns !== state.columns || table.aligns.join(",") !== state.aligns) return false;
		const contextChanged = state.context !== this.context;
		state.text = this.text;
		state.context = this.context;
		for (const cell of dom.querySelectorAll<HTMLElement>("[data-row]")) {
			const source = table.rows[Number(cell.dataset.row)].cells[Number(cell.dataset.column)]?.text ?? "";
			const focused = !view.state.readOnly && cell === dom.ownerDocument.activeElement;
			if (source !== cell.dataset.source) {
				// The text changed from outside this cell: an undo, or a change to the file.
				showCell(cell, source, this.context, focused);
				if (focused) caretAt(cell, "end");
			} else if (contextChanged && !focused) {
				showCell(cell, source, this.context);
			}
		}
		void view;
		return true;
	}

	destroy(dom: HTMLElement): void {
		dropPick(dom);
		shown.get(dom)?.observer?.disconnect();
		shown.delete(dom);
	}

	ignoreEvent(): boolean {
		return true;
	}

	/**
	 * A grip beside the row and above the column of the cell the pointer is over. Dragging it moves that row or column to
	 * where it is let go; a line marks the place while it is dragged. The header row is not a row that moves.
	 */
	private attachHandles(view: EditorView, wrap: HTMLElement, scroll: HTMLElement, element: HTMLTableElement): void {
		const labels = this.hooks(view)?.labels;
		const makeHandle = (kind: "row" | "column") => {
			const handle = document.createElement("div");
			handle.className = `cm-live-table-handle cm-live-table-handle-${kind}`;
			handle.title = kind === "row" ? labels?.moveRow ?? "" : labels?.moveColumn ?? "";
			handle.setAttribute("aria-label", handle.title);
			// Six dots, drawn by the style: three across and two down on the column's grip, two across and three down on the row's.
			const dots = document.createElement("span");
			dots.className = "cm-live-table-dots";
			handle.append(dots);
			handle.dataset.kind = kind;
			handle.hidden = true;
			return handle;
		};
		const rowHandle = makeHandle("row");
		const columnHandle = makeHandle("column");
		const marker = document.createElement("div");
		marker.className = "cm-live-table-drop";
		marker.hidden = true;
		// The row or column a grip would move, framed while the pointer is on the grip and while it is dragged.
		const frame = document.createElement("div");
		frame.className = "cm-live-table-frame";
		frame.hidden = true;
		wrap.append(rowHandle, columnHandle, marker, frame);
		const showFrame = (kind: "row" | "column", index: number) => {
			const wrapRect = wrap.getBoundingClientRect();
			const tableRect = element.getBoundingClientRect();
			const box = kind === "row"
				? element.rows[index]?.getBoundingClientRect()
				: element.rows[0]?.cells[index]?.getBoundingClientRect();
			if (!box) return;
			frame.hidden = false;
			frame.dataset.kind = kind;
			frame.style.left = `${(kind === "row" ? tableRect.left : box.left) - wrapRect.left}px`;
			frame.style.top = `${(kind === "row" ? box.top : tableRect.top) - wrapRect.top}px`;
			frame.style.width = `${kind === "row" ? tableRect.width : box.width}px`;
			frame.style.height = `${kind === "row" ? box.height : tableRect.height}px`;
		};
		for (const [kind, handle] of [["row", rowHandle], ["column", columnHandle]] as const) {
			handle.addEventListener("mouseenter", () => {
				const index = kind === "row" ? over?.row : over?.column;
				if (dragging || index === null || index === undefined) return;
				showFrame(kind, index);
			});
			handle.addEventListener("mouseleave", () => {
				if (!dragging) frame.hidden = true;
			});
		}

		// Which row or column the pointer is beside: a column when it is above the table, a row when it is left of it. Over
		// the cells themselves there is none, so the grips show only from the edges.
		let over: { row: number | null; column: number | null } | null = null;
		const place = () => {
			const wrapRect = wrap.getBoundingClientRect();
			const tableRect = element.getBoundingClientRect();
			rowHandle.hidden = !over || over.row === null || over.row === 0;
			columnHandle.hidden = !over || over.column === null;
			// Outside the table: the row's grip in the space to its left, the column's in the space above it.
			if (!rowHandle.hidden && over?.row != null) {
				const box = element.rows[over.row]?.getBoundingClientRect();
				if (box) {
					rowHandle.style.left = `${tableRect.left - wrapRect.left - rowHandle.offsetWidth - 3}px`;
					rowHandle.style.top = `${box.top - wrapRect.top + box.height / 2 - rowHandle.offsetHeight / 2}px`;
				}
			}
			if (!columnHandle.hidden && over?.column != null) {
				const box = element.rows[0]?.cells[over.column]?.getBoundingClientRect();
				if (box) {
					columnHandle.style.top = `${tableRect.top - wrapRect.top - columnHandle.offsetHeight - 3}px`;
					columnHandle.style.left = `${box.left - wrapRect.left + box.width / 2 - columnHandle.offsetWidth / 2}px`;
				}
			}
		};
		wrap.addEventListener("mousemove", (event) => {
			if (dragging) return;
			const tableRect = element.getBoundingClientRect();
			let next: typeof over = null;
			const inColumns = event.clientX >= tableRect.left && event.clientX <= tableRect.right;
			const inRows = event.clientY >= tableRect.top && event.clientY <= tableRect.bottom;
			if (event.clientY < tableRect.top && inColumns) {
				const cells = Array.from(element.rows[0]?.cells ?? []);
				const column = cells.findIndex((cell) => event.clientX < cell.getBoundingClientRect().right);
				if (column !== -1) next = { row: null, column };
			} else if (event.clientX < tableRect.left && inRows) {
				const rows = Array.from(element.rows);
				const row = rows.findIndex((line) => event.clientY < line.getBoundingClientRect().bottom);
				if (row !== -1) next = { row, column: null };
			}
			if (next?.row === over?.row && next?.column === over?.column) return;
			over = next;
			place();
		});
		wrap.addEventListener("mouseleave", () => {
			if (dragging) return;
			over = null;
			place();
		});

		let dragging = false;
		const begin = (kind: "row" | "column") => (event: MouseEvent) => {
			const index = kind === "row" ? over?.row : over?.column;
			if (event.button !== 0 || index === null || index === undefined) return;
			event.preventDefault();
			event.stopPropagation();
			const from = index;
			const lines = kind === "row"
				? Array.from(element.rows, (row) => row.getBoundingClientRect())
				: Array.from(element.rows[0]?.cells ?? [], (cell) => cell.getBoundingClientRect());
			dragging = true;
			wrap.classList.add("cm-live-table-dragging");
			showFrame(kind, from);
			let target = from;
			const track = (move: MouseEvent) => {
				const wrapRect = wrap.getBoundingClientRect();
				const pointer = kind === "row" ? move.clientY : move.clientX;
				// The line the pointer is over; rows are counted from the first body row, columns from the first.
				let index = lines.findIndex((box) => pointer < (kind === "row" ? box.bottom : box.right));
				if (index === -1) index = lines.length - 1;
				if (kind === "row") index = Math.max(index, 1);
				target = index;
				const box = lines[index];
				marker.hidden = false;
				marker.dataset.kind = kind;
				// The mark goes at the far edge of the line the row or column will take the place of, on the side it comes from.
				const forward = index > from;
				if (kind === "row") {
					marker.style.top = `${(forward ? box.bottom : box.top) - wrapRect.top - 1}px`;
					marker.style.left = `${lines[0] ? element.getBoundingClientRect().left - wrapRect.left : 0}px`;
					marker.style.width = `${element.getBoundingClientRect().width}px`;
					marker.style.height = "2px";
				} else {
					marker.style.left = `${(forward ? box.right : box.left) - wrapRect.left - 1}px`;
					marker.style.top = `${element.getBoundingClientRect().top - wrapRect.top}px`;
					marker.style.height = `${element.getBoundingClientRect().height}px`;
					marker.style.width = "2px";
				}
			};
			const finish = () => {
				document.removeEventListener("mousemove", track, true);
				document.removeEventListener("mouseup", finish, true);
				window.removeEventListener("blur", finish);
				dragging = false;
				wrap.classList.remove("cm-live-table-dragging");
				marker.hidden = true;
				frame.hidden = true;
				if (target !== from) editTable(view, wrap, { kind: kind === "row" ? "move-row" : "move-column", from, to: target });
			};
			document.addEventListener("mousemove", track, true);
			document.addEventListener("mouseup", finish, true);
			window.addEventListener("blur", finish);
			track(event);
		};
		rowHandle.addEventListener("mousedown", begin("row"));
		columnHandle.addEventListener("mousedown", begin("column"));
		scroll.addEventListener("scroll", place);
	}

	private addButton(className: string, label: string, view: EditorView, wrap: HTMLElement, kind: "row" | "column"): HTMLElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = className;
		button.title = label;
		button.setAttribute("aria-label", label);
		button.textContent = "+";
		// Keeps the focus where it is; a click adds a line or a column and puts the caret in it.
		button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("click", () => {
			const found = currentTable(view, wrap);
			if (found) editTable(view, wrap, kind === "row" ? { kind: "insert-row", at: found.table.rows.length } : { kind: "insert-column", at: found.table.columns });
		});
		return button;
	}

	private listen(cell: HTMLElement, wrap: HTMLElement, view: EditorView): void {
		const openEmbedMenu = (event: MouseEvent | KeyboardEvent): boolean => {
			const embed = event.target instanceof Element ? event.target.closest<HTMLElement>(".markdown-cell-embed") : null;
			const target = embed?.querySelector<HTMLElement>(`${EMBED_LINK_SELECTOR}, ${EMBED_IMAGE_SELECTOR}`);
			const assetId = target?.dataset.assetId ?? target?.dataset.embedImageId;
			const hooks = this.hooks(view);
			if (!embed || !assetId || !hooks) return false;
			event.preventDefault();
			event.stopPropagation();
			const { doc, readOnly } = view.state;
			const offset = Number(embed.dataset.sourceFrom) + 3;
			void hooks.chooseEmbedAction(readOnly).then((action) => {
				if (!embed.isConnected || view.state.doc !== doc) return;
				if (action === "open_embed") hooks.openAsset(assetId, target?.dataset.anchor);
				if (action === "edit_embed" && !view.state.readOnly) {
					dropPick(wrap);
					cell.focus({ preventScroll: true });
					selectCellText(cell, { from: offset, to: offset });
				}
			}).catch(() => undefined);
			return true;
		};
		let reference: ReturnType<typeof pressedReference>;
		cell.addEventListener("mousedown", (event) => {
			reference = pressedReference(event);
			if (event.button === 2) { event.preventDefault(); return; }
			if (event.button !== 0) return;
			const href = (event.target as HTMLElement | null)?.closest("a")?.getAttribute("href");
			if (href && /^(https?:|mailto:)/i.test(href) && (view.state.readOnly || event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				window.open(href, "_blank", "noopener,noreferrer");
				return;
			}
			// A press in a cell ends a block that was picked, and may start a new one by being dragged into another cell.
			dropPick(wrap);
			trackPress(wrap, { row: Number(cell.dataset.row), column: Number(cell.dataset.column) });
			if (event.target instanceof Element && event.target.matches(EMBED_IMAGE_SELECTOR)) return;
			if (reference) {
				if (!view.state.readOnly) event.preventDefault();
				return;
			}
			// A cell that is not being edited shows its result. A click turns it into its text first.
			if (!view.state.readOnly && cell !== cell.ownerDocument.activeElement) {
				event.preventDefault();
				cell.focus();
			}
		});
		cell.addEventListener("click", (event) => {
			const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>("a") : null;
			if (anchor) event.preventDefault();
			const focusedEmbed = event.detail === 0 && anchor?.matches(EMBED_LINK_SELECTOR) ? anchor : null;
			const link = focusedEmbed ?? reference?.(event);
			reference = undefined;
			if (link) this.hooks(view)?.openAsset(link.dataset.assetId ?? "", link.dataset.anchor);
		});
		cell.addEventListener("focus", () => {
			if (view.state.readOnly) return;
			holdWidths(wrap);
			showCell(cell, cell.dataset.source ?? "", shown.get(wrap)?.context ?? null, true);
			caretAt(cell, "end");
		});
		cell.addEventListener("blur", () => {
			showCell(cell, cell.dataset.source ?? "", shown.get(wrap)?.context ?? null);
			releaseWidths(wrap);
			this.hooks(view)?.save();
		});
		cell.addEventListener("input", (event) => {
			if (!(event as InputEvent).isComposing) commit(view, wrap, cell);
		});
		cell.addEventListener("compositionend", () => commit(view, wrap, cell));
		// Cells copied from a table go into the cells from this one on, to the right and down, and the table grows to hold
		// them. Text that has no cells in it is put in at the caret, as text is.
		cell.addEventListener("paste", (event) => {
			event.stopPropagation();
			if (view.state.readOnly) { event.preventDefault(); return; }
			const values = readCells(event, false);
			if (!values) return;
			event.preventDefault();
			editTable(view, wrap, { kind: "paste", row: Number(cell.dataset.row), column: Number(cell.dataset.column), values });
		});
		cell.addEventListener("keydown", (event) => {
			if (event.shiftKey && event.key === "F10" && openEmbedMenu(event)) return;
			if (event.target === cell) keyInCell(event, view, wrap, cell, this.hooks(view));
		});
		cell.addEventListener("contextmenu", (event) => {
			if (openEmbedMenu(event)) return;
			const hooks = this.hooks(view);
			const found = currentTable(view, wrap);
			if (!hooks || !found) return;
			event.preventDefault();
			event.stopPropagation();
			const row = Number(cell.dataset.row);
			const column = Number(cell.dataset.column);
			// A menu opened on a cell of the picked block is for the block; anywhere else it is for that cell alone.
			let rect = pickedRect(wrap);
			if (!rect || row < rect.row1 || row > rect.row2 || column < rect.column1 || column > rect.column2) {
				dropPick(wrap);
				rect = { row1: row, column1: column, row2: row, column2: column };
			}
			const block = rect;
			const selectedText = cellSelection(cell);
			const inCell = !pickedRect(wrap) && (cell === cell.ownerDocument.activeElement || !!selectedText);
			if (!inCell) {
				wrap.focus({ preventScroll: true });
				window.getSelection()?.removeAllRanges();
				pickCells(wrap, { row: block.row1, column: block.column1 }, { row: block.row2, column: block.column2 });
			}
			const aligns = found.table.aligns.slice(block.column1, block.column2 + 1);
			// The columns are marked as aligned when they all are, and the same way.
			const align = aligns.every((one) => one === aligns[0]) ? aligns[0] ?? "" : "";
			const columns = block.column2 - block.column1 + 1;
			void hooks.chooseAction({
				readOnly: view.state.readOnly, canUndo: undoDepth(view.state) > 0, canRedo: redoDepth(view.state) > 0,
				canCopy: !inCell || !!selectedText && selectedText.from !== selectedText.to,
				canDeleteRow: block.row2 > 0, canDeleteColumn: found.table.columns > columns, align,
			}).then(async (action) => {
				if (!action || !wrap.isConnected || (view.state.readOnly && action !== "copy" && action !== "select_all")) return;
				if (action === "undo" || action === "redo") { (action === "undo" ? undo : redo)(view); return; }
				if (action === "select_all") {
					if (inCell) {
						cell.focus({ preventScroll: true });
						selectCellText(cell, { from: 0, to: cell.textContent?.length ?? 0 });
						return;
					}
					wrap.focus({ preventScroll: true });
					window.getSelection()?.removeAllRanges();
					const current = currentTable(view, wrap);
					if (current) pickCells(wrap, { row: 0, column: 0 }, { row: current.table.rows.length - 1, column: current.table.columns - 1 });
					return;
				}
				if (action === "cut" || action === "copy" || action === "paste") {
					if (inCell) {
						cell.focus({ preventScroll: true });
						if (selectedText) selectCellText(cell, selectedText);
					} else {
						wrap.focus({ preventScroll: true });
						pickCells(wrap, { row: block.row1, column: block.column1 }, { row: block.row2, column: block.column2 });
					}
					await hooks.clipboard(action);
					return;
				}
				const edit = editFor(action, block, align);
				if (edit) editTable(view, wrap, edit);
			});
		});
	}

	/** The keys, copy and paste of a table while a block of its cells is picked. */
	private listenPicked(wrap: HTMLElement, view: EditorView): void {
		wrap.addEventListener("focusout", (event) => {
			// Focus moving on ends the pick. Not when the whole window loses it, as the native menu does.
			if (!wrap.contains(event.relatedTarget as Node | null) && wrap.ownerDocument.hasFocus()) dropPick(wrap);
		});
		wrap.addEventListener("keydown", (event) => {
			const picked = picks.get(wrap);
			if (!picked || event.target !== wrap) return;
			// Nothing reaches the editor's key bindings, which would act on the whole document.
			event.stopPropagation();
			const mod = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();
			const handled = () => event.preventDefault();
			if (mod && key === "a") {
				handled();
				const state = shown.get(wrap);
				if (state) pickCells(wrap, { row: 0, column: 0 }, { row: state.rows - 1, column: state.columns - 1 });
			} else if (mod && key === "s") {
				handled();
				this.hooks(view)?.save();
			} else if (mod && (key === "z" || key === "y")) {
				handled();
				if (!view.state.readOnly) (key === "y" || event.shiftKey ? redo : undo)(view);
			} else if (mod || event.altKey) {
				return;
			} else if (event.key === "Delete" || event.key === "Backspace") {
				handled();
				editTable(view, wrap, { kind: "clear", rect: picked.rect });
			} else {
				// Escape, the arrows, Enter and Tab end the pick and put the caret where it began; a letter does nothing.
				handled();
				if (!["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
				dropPick(wrap);
				focusCell(wrap, picked.anchor.row, picked.anchor.column, "end");
			}
		});
		const copy = (event: ClipboardEvent, cut: boolean) => {
			const picked = picks.get(wrap);
			if (!picked) return;
			event.stopPropagation();
			event.preventDefault();
			const found = currentTable(view, wrap);
			if (!found) return;
			event.clipboardData?.setData("text/plain", rectText(found.table, picked.rect));
			// The cells alone, for pasting into cells: the text above has a header put on top, which is not one of them.
			event.clipboardData?.setData(CELLS_TYPE, JSON.stringify(cellTexts(found.table, picked.rect)));
			if (cut && !view.state.readOnly) editTable(view, wrap, { kind: "clear", rect: picked.rect });
		};
		wrap.addEventListener("copy", (event) => copy(event, false));
		wrap.addEventListener("cut", (event) => copy(event, true));
		// Pasted over a block of cells, the cells go in from its top left. One cell pasted over a larger block fills it.
		wrap.addEventListener("paste", (event) => {
			const picked = picks.get(wrap);
			if (!picked) return;
			event.stopPropagation();
			event.preventDefault();
			if (view.state.readOnly) return;
			let values = readCells(event, true);
			if (!values) return;
			const { rect } = picked;
			if (values.length === 1 && values[0].length === 1) {
				values = Array.from({ length: rect.row2 - rect.row1 + 1 }, () => Array<string>(rect.column2 - rect.column1 + 1).fill(values![0][0]));
			}
			editTable(view, wrap, { kind: "paste", row: rect.row1, column: rect.column1, values });
		});
	}
}

/** A block of cells picked by dragging from one cell into another, and the frame drawn round it. */
interface Pick {
	rect: CellRect;
	anchor: { row: number; column: number };
	frame: HTMLElement;
}

const picks = new WeakMap<HTMLElement, Pick>();

/** What a copy of cells carries besides its text: the cells themselves, row by row. */
const CELLS_TYPE = "application/x-loom-table-cells";

/**
 * The cells on the clipboard: those a copy from a table left, or text with tabs and line breaks in it, which is how
 * other tables put cells on it. Plain one-line text counts as one cell only when `single` says so.
 */
function readCells(event: ClipboardEvent, single: boolean): string[][] | null {
	const data = event.clipboardData;
	if (!data) return null;
	const own = data.getData(CELLS_TYPE);
	if (own) {
		try {
			const parsed: unknown = JSON.parse(own);
			if (Array.isArray(parsed) && parsed.every((line) => Array.isArray(line) && line.every((value) => typeof value === "string"))) return parsed as string[][];
		} catch {
			// Not ours after all; the text is read instead.
		}
	}
	const text = data.getData("text/plain").replace(/\r\n?/g, "\n").replace(/\n$/, "");
	if (!text) return null;
	if (!single && !/[\t\n]/.test(text)) return null;
	return text.split("\n").map((line) => line.split("\t"));
}

/** The cell under a point, or the nearest one when the point is outside the table, so a drag may leave it. */
function cellAt(wrap: HTMLElement, x: number, y: number): { row: number; column: number } | null {
	const rows = Array.from(wrap.querySelector("table")?.rows ?? []);
	if (!rows.length) return null;
	let row = rows.findIndex((line) => y < line.getBoundingClientRect().bottom);
	if (row === -1) row = rows.length - 1;
	const cells = Array.from(rows[row].cells);
	let column = cells.findIndex((cell) => x < cell.getBoundingClientRect().right);
	if (column === -1) column = cells.length - 1;
	return { row, column };
}

function pickedRect(wrap: HTMLElement): CellRect | null {
	return picks.get(wrap)?.rect ?? null;
}

/** Picks the block of cells between two cells and draws a frame round it. */
function pickCells(wrap: HTMLElement, anchor: { row: number; column: number }, to: { row: number; column: number }): void {
	const rect: CellRect = {
		row1: Math.min(anchor.row, to.row),
		column1: Math.min(anchor.column, to.column),
		row2: Math.max(anchor.row, to.row),
		column2: Math.max(anchor.column, to.column),
	};
	let pick = picks.get(wrap);
	if (!pick) {
		const frame = document.createElement("div");
		frame.className = "cm-live-table-range";
		wrap.append(frame);
		pick = { rect, anchor, frame };
		picks.set(wrap, pick);
	}
	pick.rect = rect;
	pick.anchor = anchor;
	const first = wrap.querySelector<HTMLElement>(`[data-row="${rect.row1}"][data-column="${rect.column1}"]`)?.getBoundingClientRect();
	const last = wrap.querySelector<HTMLElement>(`[data-row="${rect.row2}"][data-column="${rect.column2}"]`)?.getBoundingClientRect();
	if (!first || !last) return;
	const box = wrap.getBoundingClientRect();
	pick.frame.style.left = `${first.left - box.left}px`;
	pick.frame.style.top = `${first.top - box.top}px`;
	pick.frame.style.width = `${last.right - first.left}px`;
	pick.frame.style.height = `${last.bottom - first.top}px`;
}

function dropPick(wrap: HTMLElement): void {
	picks.get(wrap)?.frame.remove();
	picks.delete(wrap);
}

/**
 * Follows the mouse from a press in a cell. Dragged into another cell, it stops being a text selection in the cell
 * and becomes a block of cells, from the one that was pressed to the one under the pointer.
 */
function trackPress(wrap: HTMLElement, anchor: { row: number; column: number }): void {
	let picking = false;
	const end = () => {
		document.removeEventListener("mousemove", move, true);
		document.removeEventListener("mouseup", end, true);
		window.removeEventListener("blur", end);
		wrap.classList.remove("cm-live-table-picking");
	};
	const move = (event: MouseEvent) => {
		if (event.buttons === 0) return end();
		const at = cellAt(wrap, event.clientX, event.clientY);
		if (!at) return;
		if (!picking) {
			if (at.row === anchor.row && at.column === anchor.column) return;
			picking = true;
			wrap.classList.add("cm-live-table-picking");
			// The caret leaves the cell, and the table itself takes the keys.
			const active = wrap.ownerDocument.activeElement;
			if (active instanceof HTMLElement && active !== wrap && wrap.contains(active)) active.blur();
			window.getSelection()?.removeAllRanges();
			wrap.focus({ preventScroll: true });
		}
		event.preventDefault();
		pickCells(wrap, anchor, at);
	};
	document.addEventListener("mousemove", move, true);
	document.addEventListener("mouseup", end, true);
	window.addEventListener("blur", end);
}

/**
 * A cell being edited shows its source, which is wider than what it renders to. The columns share the width by what
 * they hold, so the table would shift under the caret. While a cell is edited the columns keep the widths they had.
 */
function holdWidths(wrap: HTMLElement): void {
	const table = wrap.querySelector("table");
	const first = table?.rows[0];
	if (!table || !first) return;
	const widths = Array.from(first.cells, (cell) => cell.getBoundingClientRect().width);
	const total = table.getBoundingClientRect().width;
	Array.from(first.cells).forEach((cell, index) => {
		cell.style.width = `${widths[index]}px`;
	});
	table.style.tableLayout = "fixed";
	table.style.width = `${total}px`;
}

function releaseWidths(wrap: HTMLElement): void {
	const table = wrap.querySelector("table");
	if (!table) return;
	table.style.tableLayout = "";
	table.style.width = "";
	for (const cell of Array.from(table.rows[0]?.cells ?? [])) cell.style.width = "";
}

/** The text of a cell as the cell itself holds it: written to the file, and shown by {@link showCell}. */
function showCell(cell: HTMLElement, source: string, context: TableContext | null, editing = false): void {
	cell.dataset.source = source;
	if (editing) {
		cell.textContent = source;
		return;
	}
	cell.innerHTML = source ? renderInlineMarkdown(source, context ? { fromRelativePath: context.fromRelativePath, assets: [], lookup: context.lookup } : undefined) : "";
}

/** The part of the document the table occupies, found from its drawing. */
export function tableRange(view: EditorView, wrap: HTMLElement): { from: number; to: number } | null {
	const at = view.posAtDOM(wrap);
	for (let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(at, 1); node; node = node.parent) {
		if (node.name === "Table") return { from: node.from, to: node.to };
	}
	return null;
}

function currentTable(view: EditorView, wrap: HTMLElement): { range: { from: number; to: number }; table: ParsedTable } | null {
	const range = tableRange(view, wrap);
	const table = range ? parseTable(view.state.doc.sliceString(range.from, range.to)) : null;
	return range && table ? { range, table } : null;
}

/** Carry the caret from a focused cell into the document before a mode switch destroys its widget. */
export function leaveCell(view: EditorView): boolean {
	const active = view.dom.ownerDocument.activeElement;
	if (!(active instanceof HTMLElement)) return false;
	const wrap = active.closest<HTMLElement>(".cm-live-table");
	if (!wrap || !view.dom.contains(wrap)) return false;
	const found = currentTable(view, wrap);
	if (!found) return false;
	const cell = found.table.rows[Number(active.dataset.row)]?.cells[Number(active.dataset.column)];
	let offset = 0;
	const selection = window.getSelection();
	if (cell && selection?.rangeCount && active.contains(selection.anchorNode)) {
		const range = selection.getRangeAt(0).cloneRange();
		range.selectNodeContents(active);
		range.setEnd(selection.anchorNode!, selection.anchorOffset);
		offset = range.toString().length;
	}
	active.blur();
	dropPick(wrap);
	const anchor = found.range.from + (cell ? Math.min(cell.to, cell.from + offset) : 0);
	view.dispatch({ selection: { anchor } });
	return true;
}

/** Writes what a cell holds into the file as a change to that cell alone. */
function commit(view: EditorView, wrap: HTMLElement, cell: HTMLElement): void {
	if (view.state.readOnly) return;
	const found = currentTable(view, wrap);
	if (!found) return;
	const value = cell.textContent ?? "";
	const change = cellChange(found.table, Number(cell.dataset.row), Number(cell.dataset.column), value);
	// What the file will hold for this cell, so the table's own redraw does not take it for a change from outside.
	cell.dataset.source = escapeCell(value);
	if (!change) return;
	view.dispatch({
		changes: { from: found.range.from + change.from, to: found.range.from + change.to, insert: change.insert },
		userEvent: "input",
	});
}

/** What can be done to a table at a cell. */
export type TableEdit =
	| { kind: "insert-row"; at: number; count?: number }
	| { kind: "insert-column"; at: number; count?: number }
	| { kind: "delete-row"; at: number; last?: number }
	| { kind: "delete-column"; at: number; last?: number }
	| { kind: "align"; at: number; last?: number; align: TableAlign }
	| { kind: "clear"; rect: CellRect }
	| { kind: "paste"; row: number; column: number; values: string[][] }
	| { kind: "move-row"; from: number; to: number }
	| { kind: "move-column"; from: number; to: number };

/** Applies an edit to the table drawn at `wrap` and puts the caret in a cell that makes sense afterwards. */
function editTable(view: EditorView, wrap: HTMLElement, edit: TableEdit): void {
	if (view.state.readOnly) return;
	const found = currentTable(view, wrap);
	if (!found) return;
	dropPick(wrap);
	const { range, table } = found;
	const text = view.state.doc.sliceString(range.from, range.to);
	const shift = (change: { from: number; to: number; insert: string }) => ({ from: range.from + change.from, to: range.from + change.to, insert: change.insert });
	let changes: { from: number; to: number; insert: string }[] | null = null;
	let focus: { row: number; column: number };
	switch (edit.kind) {
		case "insert-row": {
			const at = Math.min(Math.max(edit.at, 1), table.rows.length);
			changes = [shift(insertRow(table, at, text, edit.count ?? 1))];
			focus = { row: at, column: 0 };
			break;
		}
		case "insert-column": {
			const at = Math.min(Math.max(edit.at, 0), table.columns);
			changes = insertColumn(table, at, text, edit.count ?? 1).map(shift);
			focus = { row: 0, column: at };
			break;
		}
		case "delete-row": {
			const last = edit.last ?? edit.at;
			const change = removeRow(table, edit.at, text, last);
			changes = change ? [shift(change)] : null;
			focus = { row: Math.max(0, Math.min(edit.at, table.rows.length - 1 - (Math.min(last, table.rows.length - 1) - edit.at + 1))), column: 0 };
			break;
		}
		case "delete-column": {
			const last = edit.last ?? edit.at;
			changes = removeColumn(table, edit.at, last)?.map(shift) ?? null;
			focus = { row: 0, column: Math.max(0, Math.min(edit.at, table.columns - 1 - (Math.min(last, table.columns - 1) - edit.at + 1))) };
			break;
		}
		case "move-row": {
			const change = moveRow(table, edit.from, edit.to, text);
			changes = change ? [shift(change)] : null;
			focus = { row: edit.to, column: 0 };
			break;
		}
		case "move-column": {
			changes = moveColumn(table, edit.from, edit.to, text)?.map(shift) ?? null;
			focus = { row: 0, column: edit.to };
			break;
		}
		case "align": {
			const found: { from: number; to: number; insert: string }[] = [];
			for (let column = edit.at; column <= (edit.last ?? edit.at); column++) {
				const change = setAlign(table, column, edit.align, text);
				if (change) found.push(shift(change));
			}
			changes = found.length ? found : null;
			focus = { row: 0, column: edit.at };
			break;
		}
		case "paste": {
			const change = pasteCells(text, edit.row, edit.column, edit.values);
			changes = change ? [shift(change)] : null;
			focus = { row: edit.row, column: edit.column };
			break;
		}
		case "clear": {
			const found = clearCells(table, edit.rect).map(shift);
			changes = found.length ? found : null;
			focus = { row: edit.rect.row1, column: edit.rect.column1 };
			break;
		}
	}
	if (!changes) return;
	pendingFocus = { from: range.from, ...focus };
	view.dispatch({ changes, userEvent: "input" });
	// A table that kept its shape is carried over, not drawn again, so the caret is put in its cell from here.
	requestAnimationFrame(() => {
		if (pendingFocus?.from !== range.from || !wrap.isConnected) return;
		const { row, column } = pendingFocus;
		pendingFocus = null;
		focusCell(wrap, row, column, "start");
	});
}

/** The edit a menu choice stands for at a cell, or null when the choice is not an edit. */
function editFor(action: TableContextAction, rect: CellRect, current: TableAlign): TableEdit | null {
	// Choosing the alignment the columns already have takes it off.
	const align = (to: TableAlign): TableEdit => ({ kind: "align", at: rect.column1, last: rect.column2, align: current === to ? "" : to });
	// As many rows or columns are added as the block covers. The header is not a row that is added beside.
	const firstRow = Math.max(rect.row1, 1);
	const rows = Math.max(1, rect.row2 - firstRow + 1);
	const columns = rect.column2 - rect.column1 + 1;
	switch (action) {
		case "add_row_above": return { kind: "insert-row", at: firstRow, count: rows };
		case "add_row_below": return { kind: "insert-row", at: rect.row2 + 1, count: rows };
		case "add_column_left": return { kind: "insert-column", at: rect.column1, count: columns };
		case "add_column_right": return { kind: "insert-column", at: rect.column2 + 1, count: columns };
		case "delete_row": return { kind: "delete-row", at: firstRow, last: rect.row2 };
		case "delete_column": return { kind: "delete-column", at: rect.column1, last: rect.column2 };
		case "align_left": return align("left");
		case "align_center": return align("center");
		case "align_right": return align("right");
		default: return null;
	}
}

/** Puts the caret in a cell of the table drawn at `from`. Returns false when no such table is on the page. */
export function enterTable(view: EditorView, from: number, edge: "first" | "last", by: "line" | "char" = "line"): boolean {
	for (const wrap of view.contentDOM.querySelectorAll<HTMLElement>(".cm-live-table")) {
		if (view.posAtDOM(wrap) !== from) continue;
		const state = shown.get(wrap);
		if (!state) return false;
		// By line, the caret goes to the nearest row. By character, to the very first or last cell.
		if (by === "char" && edge === "last") return focusCell(wrap, state.rows - 1, state.columns - 1, "end");
		return focusCell(wrap, edge === "first" ? 0 : state.rows - 1, 0, "start");
	}
	return false;
}

function focusCell(wrap: HTMLElement, row: number, column: number, caret: "start" | "end"): boolean {
	const cell = wrap.querySelector<HTMLElement>(`[data-row="${row}"][data-column="${column}"]`);
	if (!cell) return false;
	cell.focus();
	caretAt(cell, caret);
	return true;
}

function caretAt(cell: HTMLElement, where: "start" | "end"): void {
	const range = document.createRange();
	range.selectNodeContents(cell);
	range.collapse(where === "start");
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
}

/** Keep text offsets, not DOM nodes: a cell may swap between rendered text and source while the menu is open. */
function cellSelection(cell: HTMLElement): { from: number; to: number } | null {
	const selection = cell.ownerDocument.getSelection();
	if (!selection?.rangeCount) return null;
	const range = selection.getRangeAt(0);
	if (!cell.contains(range.startContainer) || !cell.contains(range.endContainer)) return null;
	const before = range.cloneRange();
	before.selectNodeContents(cell);
	before.setEnd(range.startContainer, range.startOffset);
	const from = before.toString().length;
	before.setEnd(range.endContainer, range.endOffset);
	return { from, to: before.toString().length };
}

function selectCellText(cell: HTMLElement, selection: { from: number; to: number }): void {
	const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
	const point = (offset: number): [Node, number] => {
		walker.currentNode = cell;
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const length = node.textContent?.length ?? 0;
			if (offset <= length) return [node, offset];
			offset -= length;
		}
		return [cell, cell.childNodes.length];
	};
	const range = cell.ownerDocument.createRange();
	range.setStart(...point(selection.from));
	range.setEnd(...point(selection.to));
	const native = cell.ownerDocument.getSelection();
	native?.removeAllRanges();
	native?.addRange(range);
}

/** True when the caret is at the start or the end of the cell, with nothing selected. */
function caretEdge(cell: HTMLElement, edge: "start" | "end"): boolean {
	const selection = window.getSelection();
	if (!selection || !selection.rangeCount || !selection.isCollapsed || !cell.contains(selection.anchorNode)) return false;
	const before = selection.getRangeAt(0).cloneRange();
	before.selectNodeContents(cell);
	before.setEnd(selection.anchorNode!, selection.anchorOffset);
	const offset = before.toString().length;
	return edge === "start" ? offset === 0 : offset === (cell.textContent ?? "").length;
}

function keyInCell(event: KeyboardEvent, view: EditorView, wrap: HTMLElement, cell: HTMLElement, hooks: TableHooks | null): void {
	if (view.state.readOnly || event.isComposing) return;
	const row = Number(cell.dataset.row);
	const column = Number(cell.dataset.column);
	const state = shown.get(wrap);
	if (!state) return;
	const mod = event.metaKey || event.ctrlKey;
	// A cell is an editing context of its own: no key goes on to the editor's key bindings, which would act on the
	// whole document (select all, tab to indent). What a cell does not take itself is left to the browser.
	event.stopPropagation();
	const handled = () => event.preventDefault();
	if (mod && event.key.toLowerCase() === "a") {
		handled();
		const range = document.createRange();
		range.selectNodeContents(cell);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
	} else if (mod && event.key.toLowerCase() === "s") {
		handled();
		hooks?.save();
	} else if (mod && event.key.toLowerCase() === "z") {
		// The cell has no undo of its own: the file's history is the one that counts.
		handled();
		(event.shiftKey ? redo : undo)(view);
	} else if (mod && event.key.toLowerCase() === "y") {
		handled();
		redo(view);
	} else if (mod || event.altKey) {
		return;
	} else if (event.key === "Enter") {
		handled();
		focusCell(wrap, row + 1, column, "end");
	} else if (event.key === "Tab") {
		handled();
		const next = event.shiftKey ? [row, column - 1] : [row, column + 1];
		if (next[1] < 0) next.splice(0, 2, row - 1, state.columns - 1);
		else if (next[1] >= state.columns) next.splice(0, 2, row + 1, 0);
		if (next[0] < 0) return;
		if (next[0] >= state.rows) editTable(view, wrap, { kind: "insert-row", at: state.rows });
		else focusCell(wrap, next[0], next[1], "start");
	} else if (event.key === "ArrowUp") {
		handled();
		if (row > 0) focusCell(wrap, row - 1, column, "end");
		else leaveTable(view, wrap, cell, "before");
	} else if (event.key === "ArrowDown") {
		handled();
		if (row < state.rows - 1) focusCell(wrap, row + 1, column, "end");
		else leaveTable(view, wrap, cell, "after");
	} else if (event.key === "ArrowLeft" && !event.shiftKey && caretEdge(cell, "start")) {
		handled();
		if (row === 0 && column === 0) leaveTable(view, wrap, cell, "before");
		else if (column > 0) focusCell(wrap, row, column - 1, "end");
		else focusCell(wrap, row - 1, state.columns - 1, "end");
	} else if (event.key === "ArrowRight" && !event.shiftKey && caretEdge(cell, "end")) {
		handled();
		if (row === state.rows - 1 && column === state.columns - 1) leaveTable(view, wrap, cell, "after");
		else if (column < state.columns - 1) focusCell(wrap, row, column + 1, "start");
		else focusCell(wrap, row + 1, 0, "start");
	} else if (event.key === "Escape") {
		// Back to the text: the caret goes to the line after the table.
		handled();
		leaveTable(view, wrap, cell, "after");
	}
}

/**
 * Takes the caret out of the table to the line before or after it. A cell is a field of its own, so the browser would
 * carry its caret out by the page's layout, and the editor would read the wrong place for it. A table at the very
 * start or end of the file has no line beyond it, so a line is added there, as the caret needs a place to go.
 */
function leaveTable(view: EditorView, wrap: HTMLElement, cell: HTMLElement, side: "before" | "after"): void {
	const range = tableRange(view, wrap);
	if (view.state.readOnly || !range) return;
	cell.blur();
	if (side === "before") {
		if (range.from === 0) view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, scrollIntoView: true, userEvent: "input" });
		else view.dispatch({ selection: { anchor: range.from - 1 }, scrollIntoView: true });
	} else if (range.to >= view.state.doc.length) {
		// Two line breaks: a line that follows a table directly is one more row of it, so a blank line comes first.
		view.dispatch({ changes: { from: range.to, insert: "\n\n" }, selection: { anchor: range.to + 2 }, scrollIntoView: true, userEvent: "input" });
	} else {
		view.dispatch({ selection: { anchor: range.to + 1 }, scrollIntoView: true });
	}
	view.focus();
}
