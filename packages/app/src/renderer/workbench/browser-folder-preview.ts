import type { Asset, LibrarySnapshot } from "@loom/core";
import { compareAssetPaths, parentFolder } from "../library/tree-nav.ts";

export type BrowserFolderPreview = { kind: "asset"; asset: Asset } | { kind: "folder" };

function isMedia(asset: Asset): boolean {
	return asset.type === "image" || asset.type === "video";
}

/** One pass over direct children. Media first, then files, then subfolders; absent means empty.
 * Alphabetical ties keep covers stable when the listing's sort or search changes. */
export function browserFolderPreviews(library: Pick<LibrarySnapshot, "folders" | "assets">): ReadonlyMap<string, BrowserFolderPreview> {
	const previews = new Map<string, BrowserFolderPreview>();
	for (const path of library.folders) previews.set(parentFolder(path), { kind: "folder" });
	for (const asset of library.assets) {
		const parent = parentFolder(asset.relativePath);
		const current = previews.get(parent);
		if (!current || current.kind === "folder" || (
			isMedia(asset) !== isMedia(current.asset) ? isMedia(asset) : compareAssetPaths(asset, current.asset, "name") < 0
		)) previews.set(parent, { kind: "asset", asset });
	}
	return previews;
}
