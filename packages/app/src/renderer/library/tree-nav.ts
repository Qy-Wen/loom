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

/** Finder uses ⌘⌫. Explorer uses Delete. */
export function isLibraryTrashKey(
	event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
	mac: boolean,
): boolean {
	if (event.altKey || event.shiftKey || event.ctrlKey) return false;
	if (mac) return event.metaKey && event.key === "Backspace";
	return !event.metaKey && event.key === "Delete";
}
