/**
 * Tabs for the library workbench. Browser rules:
 * - A plain click on a file shows it in the active tab. If it is already open in another tab, that tab is shown.
 * - "Open in new tab" always adds a tab to the right of the active one, or shows the tab that already has the file.
 * - A file appears at most once.
 */
export interface AssetTabs {
	/** Open asset ids, left to right. */
	readonly ids: readonly string[];
	/** The shown tab, or null when no tab is open. */
	readonly active: string | null;
}

export const emptyAssetTabs: AssetTabs = { ids: [], active: null };

/** Show `assetId` in the active tab. */
export function showInTab(tabs: AssetTabs, assetId: string): AssetTabs {
	if (tabs.ids.includes(assetId)) return tabs.active === assetId ? tabs : { ...tabs, active: assetId };
	if (tabs.active === null) return { ids: [...tabs.ids, assetId], active: assetId };
	const ids = tabs.ids.map((id) => (id === tabs.active ? assetId : id));
	return { ids, active: assetId };
}

/** Open `assetId` in a new tab next to the active one. */
export function openInNewTab(tabs: AssetTabs, assetId: string): AssetTabs {
	if (tabs.ids.includes(assetId)) return tabs.active === assetId ? tabs : { ...tabs, active: assetId };
	const at = tabs.active === null ? tabs.ids.length : tabs.ids.indexOf(tabs.active) + 1;
	return { ids: [...tabs.ids.slice(0, at), assetId, ...tabs.ids.slice(at)], active: assetId };
}

export function activateTab(tabs: AssetTabs, assetId: string): AssetTabs {
	return tabs.ids.includes(assetId) && tabs.active !== assetId ? { ...tabs, active: assetId } : tabs;
}

/** Close a tab. Closing the active tab shows its right neighbour, or the left one when it was last. */
export function closeTab(tabs: AssetTabs, assetId: string): AssetTabs {
	const index = tabs.ids.indexOf(assetId);
	if (index < 0) return tabs;
	const ids = tabs.ids.filter((id) => id !== assetId);
	if (tabs.active !== assetId) return { ids, active: tabs.active };
	return { ids, active: ids[index] ?? ids[index - 1] ?? null };
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
 * The first file becomes the active tab. A file that is already open is moved to the drop position, not duplicated.
 */
export function insertTabs(tabs: AssetTabs, assetIds: readonly string[], beforeId: string | null): AssetTabs {
	const incoming = [...new Set(assetIds)];
	if (incoming.length === 0) return tabs;
	const rest = tabs.ids.filter((id) => !incoming.includes(id));
	// If the tab dropped on is itself being moved, it still marks the spot: count the tabs ahead of it that stay.
	const anchor = beforeId === null ? -1 : tabs.ids.indexOf(beforeId);
	const position = anchor < 0 ? rest.length : tabs.ids.slice(0, anchor).filter((id) => !incoming.includes(id)).length;
	return { ids: [...rest.slice(0, position), ...incoming, ...rest.slice(position)], active: incoming[0] };
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
