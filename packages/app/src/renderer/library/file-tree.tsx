import { useEffect, useRef, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	readLibraryDrag,
	writeLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";
import { AssetThumbnail } from "../assets/asset-thumbnail.tsx";
import { extensionOf, filenameStem, sortAssets } from "../assets/asset-utils.ts";

interface FolderNode {
	name: string;
	relativePath: string;
	folders: Map<string, FolderNode>;
	assets: Asset[];
}

export function folderSet(snapshot: LibrarySnapshot): Set<string> {
	return new Set(snapshot.folders);
}

/** Parent folder of a library-relative path: `a/b/c.jpg` → `a/b`, `notes` → ``. */
export function parentFolder(relativePath: string): string {
	return ancestorFolders(relativePath).at(-1) ?? "";
}

/** Parent folders of a library-relative file path: `a/b/c.jpg` → `["a", "a/b"]`. */
export function ancestorFolders(relativePath: string): string[] {
	const parts = relativePath.split("/").filter(Boolean);
	parts.pop();
	const folders: string[] = [];
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		folders.push(current);
	}
	return folders;
}

/** Build a render-only tree from Core's flat, portable relative paths. */
function buildFileTree(snapshot: LibrarySnapshot): FolderNode {
	const root: FolderNode = { name: "", relativePath: "", folders: new Map(), assets: [] };

	const ensureFolder = (relativePath: string): FolderNode => {
		let current = root;
		let currentPath = "";
		for (const name of relativePath.split("/").filter(Boolean)) {
			currentPath = currentPath ? `${currentPath}/${name}` : name;
			let child = current.folders.get(name);
			if (!child) {
				child = { name, relativePath: currentPath, folders: new Map(), assets: [] };
				current.folders.set(name, child);
			}
			current = child;
		}
		return current;
	};

	for (const folder of snapshot.folders) ensureFolder(folder);
	for (const asset of snapshot.assets) {
		const parts = asset.relativePath.split("/");
		parts.pop();
		ensureFolder(parts.join("/")).assets.push(asset);
	}
	return root;
}

interface AssetTreeRowProps {
	asset: Asset;
	depth: number;
	selected: boolean;
	renaming: boolean;
	cut: boolean;
	onSelect: () => void;
	onContextMenu: () => void;
	onRename: (stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropFolder: (destFolder: string | null) => void;
}

function AssetTreeRow({
	asset,
	depth,
	selected,
	renaming,
	cut,
	onSelect,
	onContextMenu,
	onRename,
	onCancelRename,
	onDropFolder,
}: AssetTreeRowProps): React.JSX.Element {
	const rowRef = useRef<HTMLElement | null>(null);
	const [stem, setStem] = useState(() => filenameStem(asset.filename));
	const cancelled = useRef(false);

	useEffect(() => setStem(filenameStem(asset.filename)), [asset.filename]);

	useEffect(() => {
		if (!selected) return;
		rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selected, asset.assetId]);

	if (renaming) {
		return (
			<div
				ref={(el) => {
					rowRef.current = el;
				}}
				className={`asset-row rename-row ${selected ? "selected" : ""}`}
				style={{ paddingLeft: 7 + depth * 14 }}
			>
				<AssetThumbnail asset={asset} />
				<div className="rename-editor">
					<input
						autoFocus
						value={stem}
						onChange={(event) => setStem(event.target.value)}
						onFocus={(event) => event.currentTarget.select()}
						onKeyDown={(event) => {
							if (event.key === "Enter") event.currentTarget.blur();
							if (event.key === "Escape") {
								cancelled.current = true;
								onCancelRename();
								event.currentTarget.blur();
							}
						}}
						onBlur={() => {
							if (!cancelled.current) void onRename(stem);
						}}
					/>
					<span>{extensionOf(asset.filename)}</span>
				</div>
			</div>
		);
	}

	return (
		<button
			ref={(el) => {
				rowRef.current = el;
			}}
			className={`asset-row ${selected ? "selected" : ""}${cut ? " cut" : ""}`}
			style={{ paddingLeft: 7 + depth * 14 }}
			type="button"
			draggable
			onDragStart={(event) => {
				writeLibraryDrag(event.dataTransfer, { kind: "asset", assetId: asset.assetId, path: asset.relativePath }, asset);
			}}
			onDragEnd={() => {
				endLibraryDrag();
				onDropFolder(null);
			}}
			onClick={onSelect}
			onContextMenu={(event) => {
				event.preventDefault();
				onContextMenu();
			}}
		>
			<AssetThumbnail asset={asset} />
			<span className="asset-name" title={asset.relativePath}>{asset.filename}</span>
		</button>
	);
}

interface FolderTreeRowProps {
	folder: FolderNode;
	depth: number;
	collapsed: boolean;
	selected: boolean;
	renaming: boolean;
	cut: boolean;
	dropFolder: string | null;
	collapsedFolders: Set<string>;
	selectedAssetId: string | null;
	selectedFolder: string | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	cutAssetIds: readonly string[];
	cutFolder: string | null;
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFolder: (destFolder: string | null) => void;
}

function FolderTreeRow({
	folder,
	depth,
	collapsed,
	selected,
	renaming,
	cut,
	dropFolder,
	...rowProps
}: FolderTreeRowProps): React.JSX.Element {
	const [name, setName] = useState(folder.name);
	const cancelled = useRef(false);

	useEffect(() => {
		cancelled.current = false;
		setName(folder.name);
	}, [folder.name, renaming]);

	function openFolder(): void {
		rowProps.onSelectFolder(folder.relativePath);
		rowProps.onToggleFolder(folder.relativePath);
	}

	return (
		<div
			onDragOver={(event) => {
				if (!hasLibraryDrag(event.dataTransfer)) return;
				event.preventDefault();
				event.stopPropagation();
				if (!canDropLibraryItem(folder.relativePath, activeLibraryDrag())) {
					event.dataTransfer.dropEffect = "none";
					return;
				}
				event.dataTransfer.dropEffect = "move";
				rowProps.onDropFolder(folder.relativePath);
			}}
			onDrop={(event) => {
				if (!hasLibraryDrag(event.dataTransfer)) return;
				event.preventDefault();
				event.stopPropagation();
				const item = readLibraryDrag(event.dataTransfer);
				endLibraryDrag();
				rowProps.onDropFolder(null);
				if (item && canDropLibraryItem(folder.relativePath, item)) {
					rowProps.onDropIntoFolder(folder.relativePath, item);
				}
			}}
		>
			<div
				className={`folder-row ${selected ? "selected" : ""}${cut ? " cut" : ""}${dropFolder === folder.relativePath ? " drop-target" : ""}`}
				style={{ paddingLeft: 7 + depth * 14 }}
			>
				<button
					className="folder-chevron"
					type="button"
					aria-label={collapsed ? "Expand folder" : "Collapse folder"}
					onClick={openFolder}
				>
					{collapsed ? "›" : "⌄"}
				</button>
				{renaming ? (
					<div className="rename-editor">
						<input
							autoFocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							onFocus={(event) => event.currentTarget.select()}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
								if (event.key === "Escape") {
									cancelled.current = true;
									rowProps.onCancelRename();
									event.currentTarget.blur();
								}
							}}
							onBlur={() => {
								if (!cancelled.current) void rowProps.onRenameFolder(folder.relativePath, name);
							}}
						/>
					</div>
				) : (
					<button
						className="folder-main"
						type="button"
						draggable
						onDragStart={(event) => {
							writeLibraryDrag(event.dataTransfer, { kind: "folder", relativePath: folder.relativePath });
						}}
						onDragEnd={() => {
							endLibraryDrag();
							rowProps.onDropFolder(null);
						}}
						onClick={openFolder}
						onContextMenu={(event) => {
							event.preventDefault();
							rowProps.onFolderContextMenu(folder.relativePath);
						}}
					>
						<span className="folder-symbol">▰</span>
						<span className="asset-name">{folder.name}</span>
					</button>
				)}
			</div>
			{!collapsed && (
				<FileTreeRows
					node={folder}
					depth={depth + 1}
					collapsedFolders={rowProps.collapsedFolders}
					selectedAssetId={rowProps.selectedAssetId}
					selectedFolder={rowProps.selectedFolder}
					renamingAssetId={rowProps.renamingAssetId}
					renamingFolder={rowProps.renamingFolder}
					cutAssetIds={rowProps.cutAssetIds}
					cutFolder={rowProps.cutFolder}
					dropFolder={dropFolder}
					onToggleFolder={rowProps.onToggleFolder}
					onSelectFolder={rowProps.onSelectFolder}
					onFolderContextMenu={rowProps.onFolderContextMenu}
					onRenameFolder={rowProps.onRenameFolder}
					onSelectAsset={rowProps.onSelectAsset}
					onAssetContextMenu={rowProps.onAssetContextMenu}
					onRenameAsset={rowProps.onRenameAsset}
					onCancelRename={rowProps.onCancelRename}
					onDropIntoFolder={rowProps.onDropIntoFolder}
					onDropFolder={rowProps.onDropFolder}
				/>
			)}
		</div>
	);
}

interface FileTreeRowsProps {
	node: FolderNode;
	depth?: number;
	collapsedFolders: Set<string>;
	selectedAssetId: string | null;
	selectedFolder: string | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	cutAssetIds: readonly string[];
	cutFolder: string | null;
	dropFolder: string | null;
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFolder: (destFolder: string | null) => void;
}

function FileTreeRows({
	node,
	depth = 0,
	collapsedFolders,
	selectedAssetId,
	selectedFolder,
	renamingAssetId,
	renamingFolder,
	cutAssetIds,
	cutFolder,
	dropFolder,
	onToggleFolder,
	onSelectFolder,
	onFolderContextMenu,
	onRenameFolder,
	onSelectAsset,
	onAssetContextMenu,
	onRenameAsset,
	onCancelRename,
	onDropIntoFolder,
	onDropFolder,
}: FileTreeRowsProps): React.JSX.Element {
	const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
	const assets = sortAssets(node.assets);

	return (
		<>
			{folders.map((folder) => (
				<FolderTreeRow
					key={folder.relativePath}
					folder={folder}
					depth={depth}
					collapsed={collapsedFolders.has(folder.relativePath)}
					selected={folder.relativePath === selectedFolder}
					renaming={folder.relativePath === renamingFolder}
					cut={cutFolder === folder.relativePath}
					dropFolder={dropFolder}
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
					onDropFolder={onDropFolder}
				/>
			))}
			{assets.map((asset) => (
				<AssetTreeRow
					key={asset.assetId}
					asset={asset}
					depth={depth}
					selected={asset.assetId === selectedAssetId}
					renaming={asset.assetId === renamingAssetId}
					cut={cutAssetIds.includes(asset.assetId)}
					onSelect={() => onSelectAsset(asset.assetId)}
					onContextMenu={() => onAssetContextMenu(asset)}
					onRename={(stem) => onRenameAsset(asset, stem)}
					onCancelRename={onCancelRename}
					onDropFolder={onDropFolder}
				/>
			))}
		</>
	);
}

export interface FileTreeProps extends Omit<FileTreeRowsProps, "node" | "depth" | "dropFolder" | "onDropFolder"> {
	library: LibrarySnapshot;
}

export function FileTree({ library, ...props }: FileTreeProps): React.JSX.Element {
	const [dropFolder, setDropFolder] = useState<string | null>(null);
	return (
		<FileTreeRows
			node={buildFileTree(library)}
			{...props}
			dropFolder={dropFolder}
			onDropFolder={setDropFolder}
		/>
	);
}
