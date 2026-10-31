import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import type { LibraryDrag } from "../assets/asset-drag.ts";
import { uiPlatform } from "../../shared/locale.ts";
import { contentModifiedAt, pointerMode, type FileSort, type FileSortDirection, type PointerMode } from "./tree-nav.ts";

export type FileDisplay = "list" | "icons";

/**
 * Everything the file tree and the shortcut lists (favorites, tags) share. Rows read it from context
 * instead of receiving it through every level of the tree.
 */
export interface TreeContextValue {
	fileDisplay: FileDisplay;
	fileSort: FileSort;
	fileSortDirection: FileSortDirection;
	collapsedFolders: ReadonlySet<string>;
	selectedKeys: ReadonlySet<string>;
	focusKey: string | null;
	/** Changes on every selection, even a repeat click on the focused row, so the tree locates it again. */
	locateToken: unknown;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	cutAssetIds: readonly string[];
	cutFolders: readonly string[];
	selectionDrag: LibraryDrag | null;
	favoriteAssetIds: ReadonlySet<string>;
	/** Newest file inside each folder, for sorting by modified time. */
	folderModifiedAt: ReadonlyMap<string, number>;
	/** Folder currently highlighted as a drop target. */
	dropFolder: string | null;
	onDropFolder: (destFolder: string | null) => void;
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string, mode: PointerMode) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string, mode: PointerMode) => void;
	onOpenAssetInTab: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFiles: (destFolder: string, files: File[]) => void;
}

const TreeContext = createContext<TreeContextValue | null>(null);

export function useTree(): TreeContextValue {
	const value = useContext(TreeContext);
	if (!value) throw new Error("useTree needs a TreeProvider");
	return value;
}

export type TreeProviderProps =
	& Omit<TreeContextValue, "favoriteAssetIds" | "folderModifiedAt" | "dropFolder" | "onDropFolder">
	& { library: LibrarySnapshot; children: React.ReactNode };

/** Owns the drop-target highlight and derives favorites and folder times from `library`. */
export function TreeProvider({ library, children, ...shared }: TreeProviderProps): React.JSX.Element {
	const [dropFolder, setDropFolder] = useState<string | null>(null);
	useEffect(() => {
		const clear = () => setDropFolder(null);
		window.addEventListener("dragend", clear);
		window.addEventListener("drop", clear);
		return () => {
			window.removeEventListener("dragend", clear);
			window.removeEventListener("drop", clear);
		};
	}, []);
	const favoriteAssetIds = useMemo(() => new Set(library.favoriteAssetIds ?? []), [library.favoriteAssetIds]);
	const folderModifiedAt = useMemo(() => contentModifiedAt(library.assets), [library.assets]);
	const value: TreeContextValue = { ...shared, favoriteAssetIds, folderModifiedAt, dropFolder, onDropFolder: setDropFolder };
	return <TreeContext.Provider value={value}>{children}</TreeContext.Provider>;
}

export function clickMode(event: React.MouseEvent): PointerMode {
	return pointerMode(event, uiPlatform(navigator.userAgent) === "mac");
}

/** Keep the focused tree row in view. `id` re-runs it when the same row component shows another file. */
export function useScrollWhenFocused(ref: React.RefObject<HTMLElement | null>, focused: boolean, id: string): void {
	const { locateToken } = useTree();
	useEffect(() => {
		if (focused) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [ref, focused, id, locateToken]);
}
