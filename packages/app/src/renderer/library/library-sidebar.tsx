import type { Asset, LibrarySnapshot } from "@loom/core";
import { FileTree } from "./file-tree.tsx";

interface LibrarySidebarProps {
	library: LibrarySnapshot;
	opening: boolean;
	selectedAssetId: string | null;
	renamingAssetId: string | null;
	collapsedFolders: Set<string>;
	onOpenLibrary: () => void;
	onToggleFolder: (relativePath: string) => void;
	onSelectAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
}

export function LibrarySidebar({
	library,
	opening,
	selectedAssetId,
	renamingAssetId,
	collapsedFolders,
	onOpenLibrary,
	onToggleFolder,
	onSelectAsset,
	onAssetContextMenu,
	onRenameAsset,
	onCancelRename,
}: LibrarySidebarProps): React.JSX.Element {
	return (
		<aside className="library-sidebar">
			<div className="library-header">
				<div>
					<div className="section-label">Asset Library</div>
					<div className="library-name" title={library.rootPath ?? undefined}>
						{library.rootPath?.split("/").filter(Boolean).at(-1) ?? "No folder open"}
					</div>
				</div>
				<button className="open-button" type="button" onClick={onOpenLibrary} disabled={opening}>
					{opening ? "…" : "Open"}
				</button>
			</div>
			{library.rootPath && (
				<div className="library-path" title={library.rootPath}>{library.rootPath}</div>
			)}

			<div className="file-heading">
				<span>Files</span>
				<span>{library.assets.length}</span>
			</div>
			{!library.rootPath ? (
				<div className="empty">Open a folder to start a local asset library.</div>
			) : library.assets.length === 0 && library.folders.length === 0 ? (
				<div className="empty">This folder is empty.</div>
			) : (
				<div className="asset-list">
					<FileTree
						library={library}
						collapsedFolders={collapsedFolders}
						selectedAssetId={selectedAssetId}
						renamingAssetId={renamingAssetId}
						onToggleFolder={onToggleFolder}
						onSelectAsset={onSelectAsset}
						onAssetContextMenu={onAssetContextMenu}
						onRenameAsset={onRenameAsset}
						onCancelRename={onCancelRename}
					/>
				</div>
			)}
		</aside>
	);
}
