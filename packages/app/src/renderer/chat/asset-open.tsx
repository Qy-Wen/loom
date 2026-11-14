import { createContext, useContext, useMemo } from "react";
import type { LoomUserAttachment } from "@loom/agent";
import type { Asset } from "@loom/core";

const AssetOpenContext = createContext<(assetId: string) => void>(() => {});
const FolderOpenContext = createContext<(path: string) => void>(() => {});
const LibraryFoldersContext = createContext<ReadonlySet<string>>(new Set());

export type OpenLibraryAsset = Pick<Asset, "assetId" | "relativePath" | "filename" | "type">;

type LibraryAsset = { path: string; filename: string; type: Asset["type"] };
const LibraryAssetsContext = createContext<ReadonlyMap<string, LibraryAsset>>(new Map());

export function AssetOpenProvider({
	onOpen,
	onOpenFolder,
	children,
}: {
	onOpen: (assetId: string) => void;
	onOpenFolder: (path: string) => void;
	children: React.ReactNode;
}): React.JSX.Element {
	return <AssetOpenContext.Provider value={onOpen}><FolderOpenContext.Provider value={onOpenFolder}>{children}</FolderOpenContext.Provider></AssetOpenContext.Provider>;
}

export function useOpenAsset(): (assetId: string) => void {
	return useContext(AssetOpenContext);
}

export function useOpenReference(): (reference: LoomUserAttachment) => void {
	const openAsset = useOpenAsset();
	const openFolder = useContext(FolderOpenContext);
	return (reference) => reference.type === "folder_ref" ? openFolder(reference.path) : openAsset(reference.assetId);
}

export function useLibraryFolders(): ReadonlySet<string> {
	return useContext(LibraryFoldersContext);
}

/** Assets in the open library, keyed by `assetId`, for reply links. */
export function LibraryAssetsProvider({
	assets,
	folders,
	children,
}: {
	assets: readonly OpenLibraryAsset[];
	folders: readonly string[];
	children: React.ReactNode;
}): React.JSX.Element {
	const index = useMemo(() => {
		const map = new Map<string, LibraryAsset>();
		for (const asset of assets) map.set(asset.assetId, { path: asset.relativePath, filename: asset.filename, type: asset.type });
		return map;
	}, [assets]);
	const folderIndex = useMemo(() => new Set(folders), [folders]);
	return <LibraryAssetsContext.Provider value={index}><LibraryFoldersContext.Provider value={folderIndex}>{children}</LibraryFoldersContext.Provider></LibraryAssetsContext.Provider>;
}

export function useLibraryAssets(): ReadonlyMap<string, LibraryAsset> {
	return useContext(LibraryAssetsContext);
}
