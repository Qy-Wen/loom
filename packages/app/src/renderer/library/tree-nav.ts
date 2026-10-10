/** Visible file-tree order and the shortcuts that move through it. */

export interface TreeAssetRef {
	assetId: string;
	relativePath: string;
}

export interface TreeRow {
	kind: "folder" | "asset";
	relativePath: string;
	assetId: string | null;
	collapsed: boolean;
}

export type TreeCursor =
	| { kind: "folder"; relativePath: string }
	| { kind: "asset"; assetId: string; relativePath: string };

export type TreeNavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Enter";

const TREE_NAV_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter"]);

export function isTreeNavKey(key: string): key is TreeNavKey {
	return TREE_NAV_KEYS.has(key);
}

export type TreeMotion =
	| { type: "select"; cursor: TreeCursor }
	| { type: "collapse"; relativePath: string }
	| { type: "expand"; relativePath: string }
	| { type: "none" };

function parentPath(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index === -1 ? "" : relativePath.slice(0, index);
}

function folderName(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index === -1 ? relativePath : relativePath.slice(index + 1);
}

/** Rows in the same order the file tree paints them, skipping children of collapsed folders. */
export function visibleTreeRows(
	folders: readonly string[],
	assets: readonly TreeAssetRef[],
	collapsed: ReadonlySet<string>,
): TreeRow[] {
	const foldersByParent = new Map<string, string[]>();
	for (const folder of folders) {
		const parent = parentPath(folder);
		const list = foldersByParent.get(parent);
		if (list) list.push(folder);
		else foldersByParent.set(parent, [folder]);
	}
	for (const list of foldersByParent.values()) {
		list.sort((a, b) => folderName(a).localeCompare(folderName(b)));
	}

	const assetsByParent = new Map<string, TreeAssetRef[]>();
	for (const asset of assets) {
		const parent = parentPath(asset.relativePath);
		const list = assetsByParent.get(parent);
		if (list) list.push(asset);
		else assetsByParent.set(parent, [asset]);
	}
	for (const list of assetsByParent.values()) {
		list.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	}

	const rows: TreeRow[] = [];
	const walk = (parent: string): void => {
		for (const folder of foldersByParent.get(parent) ?? []) {
			const isCollapsed = collapsed.has(folder);
			rows.push({ kind: "folder", relativePath: folder, assetId: null, collapsed: isCollapsed });
			if (!isCollapsed) walk(folder);
		}
		for (const asset of assetsByParent.get(parent) ?? []) {
			rows.push({ kind: "asset", relativePath: asset.relativePath, assetId: asset.assetId, collapsed: false });
		}
	};
	walk("");
	return rows;
}

function cursorOf(row: TreeRow): TreeCursor {
	return row.kind === "asset"
		? { kind: "asset", assetId: row.assetId ?? "", relativePath: row.relativePath }
		: { kind: "folder", relativePath: row.relativePath };
}

function rowIndex(rows: readonly TreeRow[], cursor: TreeCursor | null): number {
	if (!cursor) return -1;
	return rows.findIndex((row) => (
		cursor.kind === "asset"
			? row.kind === "asset" && row.assetId === cursor.assetId
			: row.kind === "folder" && row.relativePath === cursor.relativePath
	));
}

function selectAt(rows: readonly TreeRow[], index: number): TreeMotion {
	const row = rows[index];
	return row ? { type: "select", cursor: cursorOf(row) } : { type: "none" };
}

function visibleAncestor(rows: readonly TreeRow[], relativePath: string): TreeMotion {
	let parent = parentPath(relativePath);
	while (parent) {
		if (rows.some((row) => row.kind === "folder" && row.relativePath === parent)) {
			return { type: "select", cursor: { kind: "folder", relativePath: parent } };
		}
		parent = parentPath(parent);
	}
	return { type: "none" };
}

function firstChild(rows: readonly TreeRow[], index: number): TreeMotion {
	const row = rows[index];
	const next = rows[index + 1];
	if (!row || row.kind !== "folder" || !next) return { type: "none" };
	if (!next.relativePath.startsWith(`${row.relativePath}/`)) return { type: "none" };
	return { type: "select", cursor: cursorOf(next) };
}

/**
 * Move the single selection. `folding` is false while a search is showing every row,
 * so Left, Right, and Enter move through the list instead of collapsing it.
 */
export function treeMotion(
	rows: readonly TreeRow[],
	cursor: TreeCursor | null,
	key: TreeNavKey,
	folding = true,
): TreeMotion {
	const index = rowIndex(rows, cursor);
	if (key === "Home") return selectAt(rows, 0);
	if (key === "End") return selectAt(rows, rows.length - 1);
	if (key === "ArrowDown") return selectAt(rows, index < 0 ? 0 : index + 1);
	if (key === "ArrowUp") return selectAt(rows, index < 0 ? rows.length - 1 : index - 1);

	if (key === "Enter") {
		const row = rows[index];
		if (!folding || !row || row.kind !== "folder") return { type: "none" };
		return row.collapsed
			? { type: "expand", relativePath: row.relativePath }
			: { type: "collapse", relativePath: row.relativePath };
	}

	if (key === "ArrowLeft") {
		const row = rows[index];
		if (!row) return cursor ? visibleAncestor(rows, cursor.relativePath) : { type: "none" };
		if (folding && row.kind === "folder" && !row.collapsed) {
			return { type: "collapse", relativePath: row.relativePath };
		}
		return visibleAncestor(rows, row.relativePath);
	}

	if (key === "ArrowRight") {
		const row = rows[index];
		if (!row || row.kind !== "folder") return { type: "none" };
		if (folding && row.collapsed) return { type: "expand", relativePath: row.relativePath };
		return firstChild(rows, index);
	}

	return { type: "none" };
}

export function assetKey(assetId: string): string {
	return `asset:${assetId}`;
}

export function folderKey(relativePath: string): string {
	return `folder:${relativePath}`;
}

export function rowKey(row: TreeRow): string {
	return row.kind === "asset" ? assetKey(row.assetId ?? "") : folderKey(row.relativePath);
}

export interface TreeSelection {
	keys: readonly string[];
	anchor: string | null;
	focus: string | null;
}

export const emptyTreeSelection: TreeSelection = { keys: [], anchor: null, focus: null };

export type PointerMode = "replace" | "toggle" | "range";

/** ⌘ click on macOS, Ctrl click on Windows. Shift always selects the visible range. */
export function pointerMode(
	event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
	mac: boolean,
): PointerMode {
	if (event.shiftKey) return "range";
	if (mac ? event.metaKey : event.ctrlKey) return "toggle";
	return "replace";
}

function rangeKeys(rows: readonly TreeRow[], from: string, to: string): string[] {
	const start = rows.findIndex((row) => rowKey(row) === from);
	const end = rows.findIndex((row) => rowKey(row) === to);
	if (start < 0 || end < 0) return [to];
	const [low, high] = start < end ? [start, end] : [end, start];
	return rows.slice(low, high + 1).map(rowKey);
}

export function singleSelection(key: string): TreeSelection {
	return { keys: [key], anchor: key, focus: key };
}

/** Right-click keeps a selection that already contains the row, and focuses that row. */
export function contextSelection(selection: TreeSelection, targetKey: string): TreeSelection {
	if (!selection.keys.includes(targetKey)) return singleSelection(targetKey);
	return { ...selection, focus: targetKey };
}

export function pointerSelect(
	selection: TreeSelection,
	rows: readonly TreeRow[],
	targetKey: string,
	mode: PointerMode,
): TreeSelection {
	if (mode === "toggle") {
		const keys = selection.keys.includes(targetKey)
			? selection.keys.filter((key) => key !== targetKey)
			: [...selection.keys, targetKey];
		const focus = keys.includes(targetKey) ? targetKey : (keys.at(-1) ?? null);
		return { keys, anchor: targetKey, focus };
	}
	if (mode === "range" && rows.some((row) => rowKey(row) === targetKey)) {
		const anchor = selection.anchor ?? selection.focus ?? targetKey;
		return { keys: rangeKeys(rows, anchor, targetKey), anchor, focus: targetKey };
	}
	return singleSelection(targetKey);
}

const EXTEND_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "Home", "End"]);

export function isExtendKey(key: string): key is "ArrowUp" | "ArrowDown" | "Home" | "End" {
	return EXTEND_KEYS.has(key);
}

/** Shift plus an arrow keeps the anchor and replaces the selection with the range. */
export function extendSelection(
	selection: TreeSelection,
	rows: readonly TreeRow[],
	key: "ArrowUp" | "ArrowDown" | "Home" | "End",
): TreeSelection {
	if (rows.length === 0) return selection;
	const current = rows.findIndex((row) => rowKey(row) === selection.focus);
	let next = current;
	if (key === "Home") next = 0;
	else if (key === "End") next = rows.length - 1;
	else if (current < 0) next = key === "ArrowDown" ? 0 : rows.length - 1;
	else if (key === "ArrowDown") next = Math.min(rows.length - 1, current + 1);
	else next = Math.max(0, current - 1);
	const focus = rowKey(rows[next]);
	const anchor = selection.anchor ?? selection.focus ?? focus;
	return { keys: rangeKeys(rows, anchor, focus), anchor, focus };
}

export function selectVisible(selection: TreeSelection, rows: readonly TreeRow[]): TreeSelection {
	if (rows.length === 0) return selection;
	const keys = rows.map(rowKey);
	const focus = selection.focus && keys.includes(selection.focus) ? selection.focus : keys[0];
	const anchor = selection.anchor && keys.includes(selection.anchor) ? selection.anchor : keys[0];
	return { keys, anchor, focus };
}

export function cursorsForKeys(keys: readonly string[], assets: readonly TreeAssetRef[]): TreeCursor[] {
	const paths = new Map(assets.map((asset) => [asset.assetId, asset.relativePath]));
	const cursors: TreeCursor[] = [];
	for (const key of keys) {
		if (key.startsWith("folder:")) {
			cursors.push({ kind: "folder", relativePath: key.slice("folder:".length) });
		} else if (key.startsWith("asset:")) {
			const assetId = key.slice("asset:".length);
			const relativePath = paths.get(assetId);
			if (relativePath) cursors.push({ kind: "asset", assetId, relativePath });
		}
	}
	return cursors;
}

/** Drop files and folders that already sit inside a selected folder. */
export function rootLibraryItems(cursors: readonly TreeCursor[]): { assetIds: string[]; folders: string[] } {
	const folders = cursors.flatMap((cursor) => cursor.kind === "folder" ? [cursor.relativePath] : []);
	const keptFolders = folders.filter((folder) => !folders.some((other) => other !== folder && folder.startsWith(`${other}/`)));
	const assetIds = cursors.flatMap((cursor) => {
		if (cursor.kind !== "asset") return [];
		if (keptFolders.some((folder) => cursor.relativePath.startsWith(`${folder}/`))) return [];
		return [cursor.assetId];
	});
	return { assetIds, folders: keptFolders };
}

export function coversPath(folders: readonly string[], relativePath: string): boolean {
	return folders.some((folder) => relativePath === folder || relativePath.startsWith(`${folder}/`));
}

export function withoutKey(selection: TreeSelection, key: string): TreeSelection {
	if (!selection.keys.includes(key)) return selection;
	const keys = selection.keys.filter((item) => item !== key);
	const focus = selection.focus === key ? (keys[0] ?? null) : selection.focus;
	const anchor = selection.anchor === key ? focus : selection.anchor;
	return { keys, focus, anchor };
}

export function withoutFolder(selection: TreeSelection, relativePath: string): TreeSelection {
	const exact = folderKey(relativePath);
	const child = `${exact}/`;
	const keys = selection.keys.filter((key) => key !== exact && !key.startsWith(child));
	if (keys.length === selection.keys.length) return selection;
	const focus = selection.focus && keys.includes(selection.focus) ? selection.focus : (keys[0] ?? null);
	const anchor = selection.anchor && keys.includes(selection.anchor) ? selection.anchor : focus;
	return { keys, focus, anchor };
}

/** Finder uses ⌘⌫. Explorer uses Delete. */
export function isLibraryTrashKey(
	event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
	mac: boolean,
): boolean {
	if (event.altKey || event.shiftKey || event.ctrlKey) return false;
	if (mac) return event.metaKey && event.key === "Backspace";
	return !event.metaKey && event.key === "Delete";
}
