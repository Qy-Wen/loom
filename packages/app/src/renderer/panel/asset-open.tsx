import { createContext, useContext, useMemo } from "react";

const AssetOpenContext = createContext<(assetId: string) => void>(() => {});

export type OpenLibraryAsset = { assetId: string; relativePath: string; filename: string };

const LibraryAssetsContext = createContext<ReadonlyMap<string, { path: string; filename: string }>>(new Map());

export function AssetOpenProvider({
	onOpen,
	children,
}: {
	onOpen: (assetId: string) => void;
	children: React.ReactNode;
}): React.JSX.Element {
	return <AssetOpenContext.Provider value={onOpen}>{children}</AssetOpenContext.Provider>;
}

export function useOpenAsset(): (assetId: string) => void {
	return useContext(AssetOpenContext);
}

/** Assets in the open library, keyed by `assetId`, for reply links. */
export function LibraryAssetsProvider({
	assets,
	children,
}: {
	assets: readonly OpenLibraryAsset[];
	children: React.ReactNode;
}): React.JSX.Element {
	const index = useMemo(() => {
		const map = new Map<string, { path: string; filename: string }>();
		for (const asset of assets) map.set(asset.assetId, { path: asset.relativePath, filename: asset.filename });
		return map;
	}, [assets]);
	return <LibraryAssetsContext.Provider value={index}>{children}</LibraryAssetsContext.Provider>;
}

export function useLibraryAssets(): ReadonlyMap<string, { path: string; filename: string }> {
	return useContext(LibraryAssetsContext);
}
