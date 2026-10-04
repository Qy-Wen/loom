import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	readLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";
import { FileTree } from "./file-tree.tsx";

interface LibrarySidebarProps {
	library: LibrarySnapshot;
	opening: boolean;
	selectedAssetId: string | null;
	selectedFolder: string | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	collapsedFolders: Set<string>;
	cutAssetIds: readonly string[];
	cutFolder: string | null;
	onOpenLibrary: () => void;
	onToggleFolder: (relativePath: string) => void;
	onSelectAsset: (assetId: string) => void;
	onSelectFolder: (relativePath: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onLibraryContextMenu: () => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onKeyDown: (event: React.KeyboardEvent) => void;
}

export function LibrarySidebar({
	library,
	opening,
	selectedAssetId,
	selectedFolder,
	renamingAssetId,
	renamingFolder,
	collapsedFolders,
	cutAssetIds,
	cutFolder,
	onOpenLibrary,
	onToggleFolder,
	onSelectAsset,
	onSelectFolder,
	onAssetContextMenu,
	onFolderContextMenu,
	onLibraryContextMenu,
	onRenameAsset,
	onRenameFolder,
	onCancelRename,
	onDropIntoFolder,
	onKeyDown,
}: LibrarySidebarProps): React.JSX.Element {
	const empty = library.assets.length === 0 && library.folders.length === 0;

	function acceptRootDrop(event: React.DragEvent): boolean {
		if (!hasLibraryDrag(event.dataTransfer) || !canDropLibraryItem("", activeLibraryDrag())) return false;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		return true;
	}

	return (
		<aside className="library-sidebar" tabIndex={0} onKeyDown={onKeyDown}>
			<div className="library-header">
				<div>
					<div className="section-label">Asset Library</div>
					<div className="library-name" title={library.rootPath ?? undefined}>
						{library.rootPath?.split(/[/\\]/).filter(Boolean).at(-1) ?? "No folder open"}
					</div>
				</div>
				<button className="open-button" type="button" onClick={onOpenLibrary} disabled={opening}>
					{opening ? "…" : "Open"}
				</button>
			</div>

			<div className="file-heading">
				<span>Files</span>
				<span>{library.assets.length}</span>
			</div>
			{!library.rootPath ? (
				<div className="empty">Open a folder to start a local asset library.</div>
			) : (
				<div
					className="asset-list"
					onDragOver={(event) => {
						acceptRootDrop(event);
					}}
					onDrop={(event) => {
						if (!acceptRootDrop(event)) return;
						const item = readLibraryDrag(event.dataTransfer);
						endLibraryDrag();
						if (item) onDropIntoFolder("", item);
					}}
					onContextMenu={(event) => {
						if (event.target !== event.currentTarget) return;
						event.preventDefault();
						onLibraryContextMenu();
					}}
				>
					{empty ? (
						<div
							className="empty"
							onContextMenu={(event) => {
								event.preventDefault();
								onLibraryContextMenu();
							}}
						>
							This folder is empty.
						</div>
					) : (
						<FileTree
							library={library}
							collapsedFolders={collapsedFolders}
							selectedAssetId={selectedAssetId}
							selectedFolder={selectedFolder}
							renamingAssetId={renamingAssetId}
							renamingFolder={renamingFolder}
							cutAssetIds={cutAssetIds}
							cutFolder={cutFolder}
							onToggleFolder={onToggleFolder}
							onSelectFolder={onSelectFolder}
							onFolderContextMenu={onFolderContextMenu}
							onRenameFolder={onRenameFolder}
							onSelectAsset={onSelectAsset}
							onAssetContextMenu={onAssetContextMenu}
							onRenameAsset={onRenameAsset}
							onCancelRename={onCancelRename}
							onDropIntoFolder={onDropIntoFolder}
						/>
					)}
				</div>
			)}
		</aside>
	);
}
