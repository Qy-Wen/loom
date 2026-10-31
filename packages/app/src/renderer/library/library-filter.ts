import type { Asset, LibrarySnapshot } from "@loom/core";

/** The sidebar search: pure functions from a snapshot and a query to what each section shows. */

function matches(text: string, normalizedQuery: string): boolean {
	return text.toLowerCase().includes(normalizedQuery);
}

function folderNameMatches(folder: string, normalizedQuery: string): boolean {
	return matches(folder.split("/").at(-1) ?? folder, normalizedQuery);
}

/** Add `folder` and every folder above it. */
function addFolderChain(folders: Set<string>, folder: string): void {
	let current = "";
	for (const part of folder.split("/").filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		folders.add(current);
	}
}

function assetMatches(asset: Asset, normalizedQuery: string): boolean {
	return matches(asset.filename, normalizedQuery) || matches(asset.relativePath, normalizedQuery);
}

/**
 * Files whose name or path match, plus every file under a folder whose name matches,
 * together with the folders needed to reach them.
 */
export function filterLibrary(library: LibrarySnapshot, query: string): LibrarySnapshot {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return library;
	const named = library.folders.filter((folder) => folderNameMatches(folder, normalized));
	const assets = library.assets.filter((asset) => (
		assetMatches(asset, normalized) || named.some((folder) => asset.relativePath.startsWith(`${folder}/`))
	));
	const folders = new Set<string>();
	for (const folder of named) addFolderChain(folders, folder);
	for (const folder of library.folders) {
		if (named.some((hit) => folder.startsWith(`${hit}/`))) addFolderChain(folders, folder);
	}
	for (const asset of assets) {
		const parent = asset.relativePath.split("/").slice(0, -1).join("/");
		if (parent) addFolderChain(folders, parent);
	}
	return { ...library, assets, folders: [...folders] };
}

/** Favorite files, in favorite order, that match the query. */
export function filterFavorites(library: LibrarySnapshot, query: string): Asset[] {
	const byId = new Map(library.assets.map((asset) => [asset.assetId, asset]));
	const normalized = query.trim().toLowerCase();
	return (library.favoriteAssetIds ?? []).flatMap((assetId) => {
		const asset = byId.get(assetId);
		if (!asset) return [];
		if (normalized && !assetMatches(asset, normalized)) return [];
		return [asset];
	});
}

function filesForTag(library: LibrarySnapshot, tagId: string): Asset[] {
	const byId = new Map(library.assets.map((asset) => [asset.assetId, asset]));
	return library.assetTags.flatMap((row) => {
		if (row.tagId !== tagId) return [];
		const asset = byId.get(row.assetId);
		return asset ? [asset] : [];
	});
}

/** Tags with their files. A tag whose name matches keeps all its files, otherwise only matching files stay. */
export function filterTags(library: LibrarySnapshot, query: string): { tag: LibrarySnapshot["tags"][number]; files: Asset[] }[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return library.tags.map((tag) => ({ tag, files: filesForTag(library, tag.tagId) }));
	return library.tags.flatMap((tag) => {
		const files = filesForTag(library, tag.tagId);
		const nameHit = matches(tag.name, normalized);
		const matched = nameHit ? files : files.filter((asset) => assetMatches(asset, normalized));
		return matched.length > 0 || nameHit ? [{ tag, files: matched.length > 0 ? matched : files }] : [];
	});
}
