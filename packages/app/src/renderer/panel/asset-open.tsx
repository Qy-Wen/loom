import { createContext, useContext } from "react";

const AssetOpenContext = createContext<(assetId: string) => void>(() => {});

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
