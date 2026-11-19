import type { Asset } from "@loom/core";
import type { ComposerReference } from "@loom/agent";
import { parseComposerAssetInputs } from "@loom/agent/composer-asset";

/** Drag payload for sticking a library file onto the composer. Keyed by asset id; path stays relative. */
export const LOOM_ASSET_DRAG = "application/x-loom-asset";

/** Drag payload for moving a library file or folder onto another folder. */
export const LOOM_LIBRARY_DRAG = "application/x-loom-library";

export type LibraryDrag =
	| { kind: "asset"; assetId: string; path: string }
	| { kind: "folder"; relativePath: string }
	| { kind: "batch"; assets: { assetId: string; path: string }[]; folders: string[] };

let active: LibraryDrag | null = null;

function parentRelative(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index === -1 ? "" : relativePath.slice(0, index);
}

function wouldNestInside(sourceFolder: string, destFolder: string): boolean {
	return destFolder === sourceFolder || destFolder.startsWith(`${sourceFolder}/`);
}

export function activeLibraryDrag(): LibraryDrag | null {
	return active;
}

export function endLibraryDrag(): void {
	active = null;
}

export function writeAssetDrag(transfer: DataTransfer, asset: Asset): void {
	if (transfer.effectAllowed !== "copyMove" && transfer.effectAllowed !== "move") {
		transfer.effectAllowed = "copy";
	}
	transfer.setData(LOOM_ASSET_DRAG, JSON.stringify({
		assetId: asset.assetId,
		path: asset.relativePath,
		assetType: asset.type,
	}));
}

export function writeLibraryDrag(transfer: DataTransfer, item: LibraryDrag, asset?: Asset): void {
	active = item;
	transfer.effectAllowed = "copyMove";
	transfer.setData(LOOM_LIBRARY_DRAG, JSON.stringify(item));
	if (asset) writeAssetDrag(transfer, asset);
	const files = item.kind === "asset" ? [item] : item.kind === "batch" ? item.assets : [];
	const first = files[0];
	if (first) setFileDragPreview(transfer, asset?.filename ?? first.path.split("/").at(-1)!, files.length);
}

function setFileDragPreview(transfer: DataTransfer, filename: string, count: number): void {
	const preview = document.createElement("div");
	preview.className = "asset-drag-preview";
	preview.setAttribute("aria-hidden", "true");
	const label = document.createElement("div");
	label.className = "asset-drag-preview-label";
	label.textContent = count > 1 ? `${filename} +${count - 1}` : filename;
	preview.append(label);
	document.body.append(preview);
	// Anchor the pointer to the top edge of the transparent space above the label.
	transfer.setDragImage(preview, Math.round(preview.offsetWidth / 2), 0);
	requestAnimationFrame(() => preview.remove());
}

export function readAssetDrag(transfer: DataTransfer): unknown {
	const raw = transfer.getData(LOOM_ASSET_DRAG);
	if (!raw) return undefined;
	return JSON.parse(raw) as unknown;
}

export function readLibraryDrag(transfer: DataTransfer): LibraryDrag | undefined {
	const raw = transfer.getData(LOOM_LIBRARY_DRAG);
	if (raw) return JSON.parse(raw) as LibraryDrag;
	const asset = readAssetDrag(transfer);
	if (typeof asset !== "object" || asset === null) return undefined;
	const row = asset as { assetId?: unknown; path?: unknown };
	if (typeof row.assetId !== "string" || !row.assetId.trim()) return undefined;
	return {
		kind: "asset",
		assetId: row.assetId,
		path: typeof row.path === "string" ? row.path : "",
	};
}

export function hasLibraryDrag(transfer: DataTransfer): boolean {
	const types = [...transfer.types];
	return types.includes(LOOM_LIBRARY_DRAG) || types.includes(LOOM_ASSET_DRAG);
}

/** Keep folder references intact; dragging a folder never attaches all of its files. */
export function readComposerDrag(
	transfer: DataTransfer,
	assets: ReadonlyMap<string, { path: string; type: string }>,
	folders: ReadonlySet<string>,
): ComposerReference[] {
	const item = readLibraryDrag(transfer);
	if (!item) return [];
	const folderPaths = item.kind === "folder" ? [item.relativePath] : item.kind === "batch" ? item.folders : [];
	const references: unknown[] = folderPaths.filter((path) => folders.has(path)).map((path) => ({ type: "folder_ref", path }));
	for (const assetId of draggedAssetIds(item)) {
		const asset = assets.get(assetId);
		if (asset) references.push({ type: "asset_ref", assetId, path: asset.path, assetType: asset.type });
	}
	return parseComposerAssetInputs(references);
}

/** A file drag from Explorer or Finder. Internal library drags win when both are present. */
export function hasOsFileDrag(transfer: DataTransfer): boolean {
	return [...transfer.types].includes("Files") && !hasLibraryDrag(transfer);
}

/** True when dropping this item onto destFolder would actually move it. */
export function canDropLibraryItem(destFolder: string, item: LibraryDrag | null): boolean {
	if (!item) return false;
	if (item.kind === "folder") {
		if (wouldNestInside(item.relativePath, destFolder)) return false;
		return parentRelative(item.relativePath) !== destFolder;
	}
	if (item.kind === "batch") {
		if (item.folders.some((folder) => wouldNestInside(folder, destFolder))) return false;
		const folderMoves = item.folders.some((folder) => parentRelative(folder) !== destFolder);
		const assetMoves = item.assets.some((asset) => parentRelative(asset.path) !== destFolder);
		return folderMoves || assetMoves;
	}
	return parentRelative(item.path) !== destFolder;
}

/** The files a library drag carries, in order. Folders are skipped: a folder has no view to show. */
export function draggedAssetIds(item: LibraryDrag | null): string[] {
	if (!item) return [];
	if (item.kind === "asset") return [item.assetId];
	if (item.kind === "batch") return item.assets.map((asset) => asset.assetId);
	return [];
}
