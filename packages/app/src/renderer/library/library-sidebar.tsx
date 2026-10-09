import { useEffect, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	readLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";
import { FileTree, type FileDisplay } from "./file-tree.tsx";

const FILE_DISPLAY_KEY = "loom.library.fileDisplay";

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
	const [fileDisplay, setFileDisplay] = useState<FileDisplay>(() => (
		localStorage.getItem(FILE_DISPLAY_KEY) === "icons" ? "icons" : "list"
	));
	useEffect(() => {
		localStorage.setItem(FILE_DISPLAY_KEY, fileDisplay);
	}, [fileDisplay]);

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
				<span className="file-heading-tools">
					{library.rootPath ? (
						<span className="file-display" role="group" aria-label="File display">
							<button
								type="button"
								className={fileDisplay === "list" ? "active" : ""}
								aria-label="List"
								aria-pressed={fileDisplay === "list"}
								title="List"
								onClick={() => setFileDisplay("list")}
							>
								<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
									<path d="M2.5 4h11M2.5 8h11M2.5 12h11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
								</svg>
							</button>
							<button
								type="button"
								className={fileDisplay === "icons" ? "active" : ""}
								aria-label="Icons"
								aria-pressed={fileDisplay === "icons"}
								title="Icons"
								onClick={() => setFileDisplay("icons")}
							>
								<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
									<rect x="2.25" y="2.25" width="4.5" height="4.5" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
									<rect x="9.25" y="2.25" width="4.5" height="4.5" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
									<rect x="2.25" y="9.25" width="4.5" height="4.5" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
									<rect x="9.25" y="9.25" width="4.5" height="4.5" rx="0.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
								</svg>
							</button>
						</span>
					) : null}
					<span>{library.assets.length}</span>
				</span>
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
							fileDisplay={fileDisplay}
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
