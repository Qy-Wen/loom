/** Tabs for the library workbench. A file appears at most once. */
export interface AssetTabs {
	/** Open asset ids, left to right. */
	readonly ids: readonly string[];
	/** The shown tab, or null when no tab is open. */
	readonly active: string | null;
	/** Unpinned tabs, least recently viewed first. Browsing replaces only the last one. */
	readonly previews: readonly string[];
}

export const emptyAssetTabs: AssetTabs = { ids: [], active: null, previews: [] };
export type TabOpenMode = "pinned" | "preview";

/** Reuse the preview for a new file, or activate the file's existing tab. */
export function showPreviewTab(tabs: AssetTabs, assetId: string): AssetTabs {
	if (tabs.ids.includes(assetId)) return activateTab(tabs, assetId);
	const preview = tabs.previews.at(-1);
	if (preview === undefined) return openInNewTab(tabs, assetId, "preview");
	const ids = tabs.ids.map((id) => id === preview ? assetId : id);
	return { ids, active: assetId, previews: [...tabs.previews.slice(0, -1), assetId] };
}

/** Change whether browsing can replace this tab. Leave the open tabs and selection intact. */
export function setTabPinned(tabs: AssetTabs, assetId: string, pinned: boolean): AssetTabs {
	const alreadyPinned = !tabs.previews.includes(assetId);
	if (!tabs.ids.includes(assetId) || alreadyPinned === pinned) return tabs;
	if (pinned) return { ...tabs, previews: tabs.previews.filter((id) => id !== assetId) };
	const previews = tabs.active === assetId ? [...tabs.previews, assetId] : [assetId, ...tabs.previews];
	return { ...tabs, previews };
}

/** Open a tab next to the active one. A preview request preserves the state of an existing tab. */
export function openInNewTab(tabs: AssetTabs, assetId: string, mode: TabOpenMode = "pinned"): AssetTabs {
	if (tabs.ids.includes(assetId)) {
		const next = mode === "pinned" ? setTabPinned(tabs, assetId, true) : tabs;
		return activateTab(next, assetId);
	}
	const at = tabs.active === null ? tabs.ids.length : tabs.ids.indexOf(tabs.active) + 1;
	const previews = mode === "preview" ? [...tabs.previews, assetId] : tabs.previews;
	return { ids: [...tabs.ids.slice(0, at), assetId, ...tabs.ids.slice(at)], active: assetId, previews };
}

export function activateTab(tabs: AssetTabs, assetId: string): AssetTabs {
	if (!tabs.ids.includes(assetId) || tabs.active === assetId) return tabs;
	const previews = tabs.previews.includes(assetId)
		? [...tabs.previews.filter((id) => id !== assetId), assetId]
		: tabs.previews;
	return { ...tabs, active: assetId, previews };
}

/** Close a tab. Closing the active tab shows its right neighbour, or the left one when it was last. */
export function closeTab(tabs: AssetTabs, assetId: string): AssetTabs {
	const index = tabs.ids.indexOf(assetId);
	if (index < 0) return tabs;
	const ids = tabs.ids.filter((id) => id !== assetId);
	const next = { ...tabs, ids, previews: tabs.previews.filter((id) => id !== assetId) };
	if (tabs.active !== assetId) return next;
	const neighbor = ids[index] ?? ids[index - 1];
	return neighbor === undefined ? emptyAssetTabs : activateTab(next, neighbor);
}

/**
 * Move `assetId` so it sits before `beforeId`, or at the end when `beforeId` is null.
 * Which tab is active does not change, and an unknown id or a no-op move returns the same object.
 */
export function moveTab(tabs: AssetTabs, assetId: string, beforeId: string | null): AssetTabs {
	const from = tabs.ids.indexOf(assetId);
	if (from < 0 || assetId === beforeId) return tabs;
	if (beforeId !== null && !tabs.ids.includes(beforeId)) return tabs;
	const rest = tabs.ids.filter((id) => id !== assetId);
	const at = beforeId === null ? rest.length : rest.indexOf(beforeId);
	if (at === from) return tabs;
	return { ...tabs, ids: [...rest.slice(0, at), assetId, ...rest.slice(at)] };
}

/**
 * Open files dropped onto the tab strip, in order, before `beforeId` (or at the end when null).
 * New tabs are previews. Existing tabs move with their pin state, and the first dropped file becomes active.
 */
export function insertTabs(tabs: AssetTabs, assetIds: readonly string[], beforeId: string | null): AssetTabs {
	const incoming = [...new Set(assetIds)];
	if (incoming.length === 0) return tabs;
	const rest = tabs.ids.filter((id) => !incoming.includes(id));
	// If the tab dropped on is itself being moved, it still marks the spot: count the tabs ahead of it that stay.
	const anchor = beforeId === null ? -1 : tabs.ids.indexOf(beforeId);
	const position = anchor < 0 ? rest.length : tabs.ids.slice(0, anchor).filter((id) => !incoming.includes(id)).length;
	const ids = [...rest.slice(0, position), ...incoming, ...rest.slice(position)];
	const previews = [...tabs.previews, ...incoming.filter((id) => !tabs.ids.includes(id))];
	return activateTab({ ids, active: null, previews }, incoming[0]);
}

/**
 * Drop tabs whose file left the library (delete, trash, folder removal, library reset).
 * Reconcile against the asset list instead of `remove` events: a removed folder only emits `folder_remove`.
 */
export function pruneTabs(tabs: AssetTabs, exists: (assetId: string) => boolean): AssetTabs {
	if (tabs.ids.every(exists)) return tabs;
	let next = tabs;
	for (const id of tabs.ids) if (!exists(id)) next = closeTab(next, id);
	return next;
}

export interface TabFile {
	assetId: string;
	filename: string;
	relativePath: string;
}

/** The file name, plus its folder when another open tab has the same name. */
export function tabLabels(files: readonly TabFile[]): Map<string, string> {
	const counts = new Map<string, number>();
	for (const file of files) counts.set(file.filename, (counts.get(file.filename) ?? 0) + 1);
	return new Map(files.map((file) => {
		if ((counts.get(file.filename) ?? 0) < 2) return [file.assetId, file.filename];
		const slash = file.relativePath.lastIndexOf("/");
		return [file.assetId, slash < 0 ? file.filename : `${file.filename} · ${file.relativePath.slice(0, slash)}`];
	}));
}
