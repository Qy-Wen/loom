import { basename } from "node:path";
import { LibraryPaths, type Asset } from "@loom/core";
import type { UiSelectionDraft } from "../shared/ipc.ts";

/** Map files from the library picker onto indexed assets. Paths must stay inside the library. */
export function composerAssetsFromPickedFiles(
	rootPath: string,
	filePaths: string[],
	assets: ReadonlyArray<Pick<Asset, "assetId" | "relativePath" | "type">>,
): UiSelectionDraft[] {
	const paths = new LibraryPaths(rootPath);
	const byPath = new Map(assets.map((asset) => [asset.relativePath, asset]));
	const out: UiSelectionDraft[] = [];
	const seen = new Set<string>();
	for (const file of filePaths) {
		const relativePath = paths.toRelativePath(file);
		const asset = byPath.get(relativePath);
		if (!asset) throw new Error(`${basename(file)} is not in the library.`);
		if (seen.has(asset.assetId)) continue;
		seen.add(asset.assetId);
		out.push({ assetId: asset.assetId, path: asset.relativePath, assetType: asset.type });
	}
	return out;
}

export function draftsFromAssets(
	assets: ReadonlyArray<Pick<Asset, "assetId" | "relativePath" | "type">>,
): UiSelectionDraft[] {
	const out: UiSelectionDraft[] = [];
	const seen = new Set<string>();
	for (const asset of assets) {
		if (seen.has(asset.assetId)) continue;
		seen.add(asset.assetId);
		out.push({ assetId: asset.assetId, path: asset.relativePath, assetType: asset.type });
	}
	return out;
}
