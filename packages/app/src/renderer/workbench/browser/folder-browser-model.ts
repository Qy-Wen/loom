import type { Asset, LibrarySnapshot, Tag } from "@loom/core";
import {
	compareAssetPaths,
	compareFolderPaths,
	contentModifiedAt,
	parentFolder,
	type FileSort,
	type FileSortDirection,
	type TreeRow,
} from "../../library/tree-nav.ts";

/** A real folder, the tag directory, or a virtual set of files from a sidebar shortcut. */
export type BrowseLocation =
	| { kind: "folder"; path: string }
	| { kind: "favorites" }
	| { kind: "tags" }
	| { kind: "tag"; tagId: string };

export const ROOT_LOCATION: BrowseLocation = { kind: "folder", path: "" };

export function sameLocation(a: BrowseLocation, b: BrowseLocation): boolean {
	if (a.kind !== b.kind) return false;
	if (a.kind === "folder") return a.path === (b as typeof a).path;
	if (a.kind === "tag") return a.tagId === (b as typeof a).tagId;
	return true;
}

export interface BrowseListing {
	folders: string[];
	assets: Asset[];
	tags: Tag[];
}

function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The tiles of `location`, folders first. Without a query a folder shows its direct children.
 * A query searches everything below the folder: files whose path (relative to it) matches, and folders whose name matches.
 * Favorites and individual tags are flat sets of files. The tag directory lists tags by name.
 */
export function browseListing(
	library: LibrarySnapshot,
	location: BrowseLocation,
	query: string,
	sort: FileSort,
	direction: FileSortDirection,
): BrowseListing {
	const normalized = query.trim().toLowerCase();
	if (location.kind === "tags") {
		const modified = new Map(library.assets.map((asset) => [asset.assetId, asset.modifiedAt]));
		const times = new Map<string, number>();
		for (const row of library.assetTags) {
			times.set(row.tagId, Math.max(times.get(row.tagId) ?? 0, modified.get(row.assetId) ?? 0));
		}
		const tags = library.tags.filter((tag) => tag.name.toLowerCase().includes(normalized)).sort((a, b) => {
			const order = sort === "modified" ? (times.get(a.tagId) ?? 0) - (times.get(b.tagId) ?? 0) : a.name.localeCompare(b.name);
			return order ? (direction === "desc" ? -order : order) : a.name.localeCompare(b.name);
		});
		return { folders: [], assets: [], tags };
	}
	let folders: string[] = [];
	let assets: Asset[];
	if (location.kind === "folder") {
		const base = location.path;
		const prefix = base ? `${base}/` : "";
		if (!normalized) {
			folders = library.folders.filter((folder) => parentFolder(folder) === base);
			assets = library.assets.filter((asset) => parentFolder(asset.relativePath) === base);
		} else {
			folders = library.folders.filter((folder) => (
				folder.startsWith(prefix) && lastSegment(folder).toLowerCase().includes(normalized)
			));
			assets = library.assets.filter((asset) => (
				asset.relativePath.startsWith(prefix) && asset.relativePath.slice(prefix.length).toLowerCase().includes(normalized)
			));
		}
	} else {
		const ids = location.kind === "favorites"
			? new Set(library.favoriteAssetIds)
			: new Set(library.assetTags.filter((row) => row.tagId === location.tagId).map((row) => row.assetId));
		assets = library.assets.filter((asset) => ids.has(asset.assetId) && (
			!normalized || asset.relativePath.toLowerCase().includes(normalized)
		));
	}
	const times = contentModifiedAt(library.assets);
	folders.sort((a, b) => compareFolderPaths(a, b, sort, times, direction));
	assets = [...assets].sort((a, b) => compareAssetPaths(a, b, sort, direction));
	return { folders, assets, tags: [] };
}

/** The tiles as selection rows, in the order they are painted. */
export function browserRows(listing: BrowseListing): TreeRow[] {
	return [
		...listing.folders.map((relativePath): TreeRow => ({ kind: "folder", relativePath, assetId: null, collapsed: false })),
		...listing.assets.map((asset): TreeRow => ({ kind: "asset", relativePath: asset.relativePath, assetId: asset.assetId, collapsed: false })),
	];
}

export type GridKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

const GRID_KEYS = new Set<string>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

export function isGridKey(key: string): key is GridKey {
	return GRID_KEYS.has(key);
}

/** Index a key moves to in a grid of `columns` filled row by row. -1 when there is nothing to move to. */
export function gridMove(index: number, key: GridKey, columns: number, count: number): number {
	if (count <= 0) return -1;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	if (index < 0) return key === "ArrowLeft" || key === "ArrowUp" ? count - 1 : 0;
	const width = Math.max(1, columns);
	if (key === "ArrowLeft") return Math.max(0, index - 1);
	if (key === "ArrowRight") return Math.min(count - 1, index + 1);
	if (key === "ArrowUp") return index >= width ? index - width : index;
	if (index + width < count) return index + width;
	// A shorter last row: Down from the row above lands on its last tile.
	return Math.floor(index / width) < Math.floor((count - 1) / width) ? count - 1 : index;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The rectangle between two corners, whichever way the box was dragged. */
export function rectBetween(ax: number, ay: number, bx: number, by: number): Rect {
	return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** `path` after `from` was renamed or moved to `to`. Paths outside `from` come back unchanged. */
export function remapFolderPath(path: string, from: string, to: string): string {
	if (path === from) return to;
	return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
}

export function remapLocation(location: BrowseLocation, from: string, to: string): BrowseLocation {
	if (location.kind !== "folder") return location;
	const path = remapFolderPath(location.path, from, to);
	return path === location.path ? location : { kind: "folder", path };
}

/** Keep an existing location, or fall back to its nearest real or virtual parent. */
export function existingLocation(location: BrowseLocation, library: Pick<LibrarySnapshot, "folders" | "tags">): BrowseLocation {
	if (location.kind === "favorites" || location.kind === "tags") return location;
	if (location.kind === "tag") return library.tags.some((tag) => tag.tagId === location.tagId) ? location : { kind: "tags" };
	const folders = new Set(library.folders);
	let path = location.path;
	while (path && !folders.has(path)) path = parentFolder(path);
	return path === location.path ? location : { kind: "folder", path };
}

/** Crumbs from the library root down to a folder. Each carries the location a click goes to. */
export function folderCrumbs(path: string): { name: string; path: string }[] {
	const crumbs: { name: string; path: string }[] = [];
	let current = "";
	for (const name of path.split("/").filter(Boolean)) {
		current = current ? `${current}/${name}` : name;
		crumbs.push({ name, path: current });
	}
	return crumbs;
}
