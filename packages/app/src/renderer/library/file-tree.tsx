import { useEffect, useRef, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import { assetPreviewUrl, extensionOf, filenameStem, sortAssets } from "../assets/asset-utils.ts";

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

function AssetThumbnail({ asset }: { asset: Asset }): React.JSX.Element {
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);

	if (!failed && asset.type === "image") {
		return (
			<span className="asset-thumbnail media-thumbnail">
				<img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
			</span>
		);
	}
	if (!failed && asset.type === "video") {
		return (
			<span className="asset-thumbnail media-thumbnail video-thumbnail">
				<video
					src={url}
					muted
					preload="metadata"
					onLoadedMetadata={(event) => {
						const video = event.currentTarget;
						if (video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
					}}
					onError={() => setFailed(true)}
				/>
			</span>
		);
	}

	const label = asset.type === "audio"
		? "♪"
		: extensionOf(asset.filename).slice(1, 4).toUpperCase() || asset.type[0].toUpperCase();
	return <span className={`asset-thumbnail asset-badge type-${asset.type}`}>{label}</span>;
}

interface AssetTreeRowProps {
	asset: Asset;
	depth: number;
	selected: boolean;
	renaming: boolean;
	onSelect: () => void;
	onContextMenu: () => void;
	onRename: (stem: string) => Promise<void>;
	onCancelRename: () => void;
}

function AssetTreeRow({
	asset,
	depth,
	selected,
	renaming,
	onSelect,
	onContextMenu,
	onRename,
	onCancelRename,
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
			className={`asset-row ${selected ? "selected" : ""}`}
			style={{ paddingLeft: 7 + depth * 14 }}
			type="button"
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
	collapsedFolders: Set<string>;
	selectedAssetId: string | null;
	selectedFolder: string | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
}

function FolderTreeRow({
	folder,
	depth,
	collapsed,
	selected,
	renaming,
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
		<div>
			<div
				className={`folder-row ${selected ? "selected" : ""}`}
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
					onToggleFolder={rowProps.onToggleFolder}
					onSelectFolder={rowProps.onSelectFolder}
					onFolderContextMenu={rowProps.onFolderContextMenu}
					onRenameFolder={rowProps.onRenameFolder}
					onSelectAsset={rowProps.onSelectAsset}
					onAssetContextMenu={rowProps.onAssetContextMenu}
					onRenameAsset={rowProps.onRenameAsset}
					onCancelRename={rowProps.onCancelRename}
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
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
}

function FileTreeRows({
	node,
	depth = 0,
	collapsedFolders,
	selectedAssetId,
	selectedFolder,
	renamingAssetId,
	renamingFolder,
	onToggleFolder,
	onSelectFolder,
	onFolderContextMenu,
	onRenameFolder,
	onSelectAsset,
	onAssetContextMenu,
	onRenameAsset,
	onCancelRename,
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
					collapsedFolders={collapsedFolders}
					selectedAssetId={selectedAssetId}
					selectedFolder={selectedFolder}
					renamingAssetId={renamingAssetId}
					renamingFolder={renamingFolder}
					onToggleFolder={onToggleFolder}
					onSelectFolder={onSelectFolder}
					onFolderContextMenu={onFolderContextMenu}
					onRenameFolder={onRenameFolder}
					onSelectAsset={onSelectAsset}
					onAssetContextMenu={onAssetContextMenu}
					onRenameAsset={onRenameAsset}
					onCancelRename={onCancelRename}
				/>
			))}
			{assets.map((asset) => (
				<AssetTreeRow
					key={asset.assetId}
					asset={asset}
					depth={depth}
					selected={asset.assetId === selectedAssetId}
					renaming={asset.assetId === renamingAssetId}
					onSelect={() => onSelectAsset(asset.assetId)}
					onContextMenu={() => onAssetContextMenu(asset)}
					onRename={(stem) => onRenameAsset(asset, stem)}
					onCancelRename={onCancelRename}
				/>
			))}
		</>
	);
}

export interface FileTreeProps extends Omit<FileTreeRowsProps, "node" | "depth"> {
	library: LibrarySnapshot;
}

export function FileTree({ library, ...props }: FileTreeProps): React.JSX.Element {
	return <FileTreeRows node={buildFileTree(library)} {...props} />;
}
