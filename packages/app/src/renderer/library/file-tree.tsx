import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	hasOsFileDrag,
	readLibraryDrag,
	writeLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";
import { AssetThumbnail } from "../assets/asset-thumbnail.tsx";
import { extensionOf, filenameStem } from "../assets/asset-utils.ts";
import { uiPlatform } from "../../shared/locale.ts";
import { useLocale } from "../locale.tsx";
import {
	assetKey,
	compareAssetPaths,
	compareFolderPaths,
	contentModifiedAt,
	coversPath,
	folderKey,
	pointerMode,
	type FileSort,
	type FileSortDirection,
	type PointerMode,
} from "./tree-nav.ts";

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
	focused: boolean;
	renaming: boolean;
	cut: boolean;
	favorite: boolean;
	selectionDrag: LibraryDrag | null;
	onSelect: (mode: PointerMode) => void;
	onContextMenu: () => void;
	onRename: (stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropFolder: (destFolder: string | null) => void;
}

function clickMode(event: React.MouseEvent): PointerMode {
	return pointerMode(event, uiPlatform(navigator.userAgent) === "mac");
}

function AssetTreeRow({
	asset,
	depth,
	selected,
	focused,
	renaming,
	cut,
	favorite,
	selectionDrag,
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
		if (!focused) return;
		rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [focused, asset.assetId]);

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
				const single: LibraryDrag = { kind: "asset", assetId: asset.assetId, path: asset.relativePath };
				writeLibraryDrag(event.dataTransfer, selected && selectionDrag ? selectionDrag : single, asset);
			}}
			onDragEnd={() => {
				endLibraryDrag();
				onDropFolder(null);
			}}
			onClick={(event) => onSelect(clickMode(event))}
			onContextMenu={(event) => {
				event.preventDefault();
				onContextMenu();
			}}
		>
			<AssetThumbnail asset={asset} />
			<span className="asset-name" title={asset.relativePath}>{asset.filename}</span>
			{favorite ? <FavoriteMark /> : null}
		</button>
	);
}

function AssetIconTile({
	asset,
	selected,
	focused,
	renaming,
	cut,
	favorite,
	selectionDrag,
	onSelect,
	onContextMenu,
	onRename,
	onCancelRename,
	onDropFolder,
}: Omit<AssetTreeRowProps, "depth">): React.JSX.Element {
	const tileRef = useRef<HTMLElement | null>(null);
	const [stem, setStem] = useState(() => filenameStem(asset.filename));
	const cancelled = useRef(false);

	useEffect(() => setStem(filenameStem(asset.filename)), [asset.filename]);
	useEffect(() => {
		cancelled.current = false;
	}, [renaming]);
	useEffect(() => {
		if (!focused) return;
		tileRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [focused, asset.assetId]);

	return (
		<div className={`asset-icon${selected ? " selected" : ""}${cut ? " cut" : ""}`}>
			<button
				ref={(el) => {
					tileRef.current = el;
				}}
				className="asset-icon-button"
				type="button"
				draggable={!renaming}
				onDragStart={(event) => {
					const single: LibraryDrag = { kind: "asset", assetId: asset.assetId, path: asset.relativePath };
					writeLibraryDrag(event.dataTransfer, selected && selectionDrag ? selectionDrag : single, asset);
				}}
				onDragEnd={() => {
					endLibraryDrag();
					onDropFolder(null);
				}}
				onClick={(event) => onSelect(clickMode(event))}
				onContextMenu={(event) => {
					event.preventDefault();
					onContextMenu();
				}}
			>
				<AssetThumbnail asset={asset} />
				{favorite ? <FavoriteMark /> : null}
			</button>
			{renaming ? (
				<input
					className="asset-icon-rename"
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
			) : (
				<span className="asset-icon-name" title={asset.relativePath}>{asset.filename}</span>
			)}
		</div>
	);
}

export type FileDisplay = "list" | "icons";
export type { FileSort, FileSortDirection };

interface FolderTreeRowProps {
	folder: FolderNode;
	depth: number;
	collapsed: boolean;
	selected: boolean;
	renaming: boolean;
	cut: boolean;
	dropFolder: string | null;
	collapsedFolders: Set<string>;
	selectedKeys: ReadonlySet<string>;
	focusKey: string | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	cutAssetIds: readonly string[];
	cutFolders: readonly string[];
	selectionDrag: LibraryDrag | null;
	favoriteAssetIds: ReadonlySet<string>;
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string, mode: PointerMode) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string, mode: PointerMode) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFiles: (destFolder: string, files: File[]) => void;
	onDropFolder: (destFolder: string | null) => void;
	fileDisplay: FileDisplay;
	fileSort: FileSort;
	fileSortDirection: FileSortDirection;
	folderModifiedAt: ReadonlyMap<string, number>;
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
	const { t } = useLocale();
	const [name, setName] = useState(folder.name);
	const cancelled = useRef(false);

	useEffect(() => {
		cancelled.current = false;
		setName(folder.name);
	}, [folder.name, renaming]);

	const rowRef = useRef<HTMLDivElement | null>(null);
	const key = folderKey(folder.relativePath);
	const focused = rowProps.focusKey === key;
	useEffect(() => {
		if (!focused) return;
		rowRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [focused]);

	function chooseFolder(event: React.MouseEvent): void {
		const mode = clickMode(event);
		rowProps.onSelectFolder(folder.relativePath, mode);
		if (mode === "replace") rowProps.onToggleFolder(folder.relativePath);
	}

	return (
		<div
			onDragOver={(event) => {
				if (hasOsFileDrag(event.dataTransfer)) {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "copy";
					rowProps.onDropFolder(folder.relativePath);
					return;
				}
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
			onDragLeave={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) return;
				rowProps.onDropFolder(null);
			}}
			onDrop={(event) => {
				if (hasOsFileDrag(event.dataTransfer)) {
					event.preventDefault();
					event.stopPropagation();
					rowProps.onDropFolder(null);
					const files = [...event.dataTransfer.files];
					if (files.length > 0) rowProps.onDropFiles(folder.relativePath, files);
					return;
				}
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
				ref={rowRef}
				className={`folder-row ${selected ? "selected" : ""}${cut ? " cut" : ""}${dropFolder === folder.relativePath ? " drop-target" : ""}`}
				style={{ paddingLeft: 7 + depth * 14 }}
			>
				<button
					className={`folder-chevron${collapsed ? "" : " expanded"}`}
					type="button"
					aria-label={collapsed ? t.library.expandFolder : t.library.collapseFolder}
					onClick={chooseFolder}
				>
					<FolderChevronIcon />
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
							const single: LibraryDrag = { kind: "folder", relativePath: folder.relativePath };
							writeLibraryDrag(event.dataTransfer, selected && rowProps.selectionDrag ? rowProps.selectionDrag : single);
						}}
						onDragEnd={() => {
							endLibraryDrag();
							rowProps.onDropFolder(null);
						}}
						onClick={chooseFolder}
						onContextMenu={(event) => {
							event.preventDefault();
							rowProps.onFolderContextMenu(folder.relativePath);
						}}
					>
						<span className="folder-symbol" aria-hidden="true">
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
								<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2c.5 0 .9.2 1.2.6l.9 1.2c.3.4.7.6 1.2.6H19.5A1.5 1.5 0 0 1 21 9.9v7.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
							</svg>
						</span>
						<span className="asset-name">{folder.name}</span>
					</button>
				)}
			</div>
			{!collapsed && (
				<FileTreeRows
					node={folder}
					depth={depth + 1}
					collapsedFolders={rowProps.collapsedFolders}
					selectedKeys={rowProps.selectedKeys}
					focusKey={rowProps.focusKey}
					renamingAssetId={rowProps.renamingAssetId}
					renamingFolder={rowProps.renamingFolder}
					cutAssetIds={rowProps.cutAssetIds}
					cutFolders={rowProps.cutFolders}
					selectionDrag={rowProps.selectionDrag}
					favoriteAssetIds={rowProps.favoriteAssetIds}
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
					onDropFiles={rowProps.onDropFiles}
					onDropFolder={rowProps.onDropFolder}
					fileDisplay={rowProps.fileDisplay}
					fileSort={rowProps.fileSort}
					fileSortDirection={rowProps.fileSortDirection}
					folderModifiedAt={rowProps.folderModifiedAt}
				/>
			)}
		</div>
	);
}

interface FileTreeRowsProps {
	node: FolderNode;
	depth?: number;
	collapsedFolders: Set<string>;
	selectedKeys: ReadonlySet<string>;
	focusKey: string | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	cutAssetIds: readonly string[];
	cutFolders: readonly string[];
	selectionDrag: LibraryDrag | null;
	favoriteAssetIds: ReadonlySet<string>;
	dropFolder: string | null;
	onToggleFolder: (relativePath: string) => void;
	onSelectFolder: (relativePath: string, mode: PointerMode) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onSelectAsset: (assetId: string, mode: PointerMode) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFiles: (destFolder: string, files: File[]) => void;
	onDropFolder: (destFolder: string | null) => void;
	fileDisplay: FileDisplay;
	fileSort: FileSort;
	fileSortDirection: FileSortDirection;
	folderModifiedAt: ReadonlyMap<string, number>;
}

function FileTreeRows({
	node,
	depth = 0,
	collapsedFolders,
	selectedKeys,
	focusKey,
	renamingAssetId,
	renamingFolder,
	cutAssetIds,
	cutFolders,
	selectionDrag,
	favoriteAssetIds,
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
	onDropFiles,
	onDropFolder,
	fileDisplay,
	fileSort,
	fileSortDirection,
	folderModifiedAt,
}: FileTreeRowsProps): React.JSX.Element {
	const folders = [...node.folders.values()].sort((a, b) => (
		compareFolderPaths(a.relativePath, b.relativePath, fileSort, folderModifiedAt, fileSortDirection)
	));
	const assets = [...node.assets].sort((a, b) => compareAssetPaths(a, b, fileSort, fileSortDirection));

	return (
		<>
			{folders.map((folder) => (
				<FolderTreeRow
					key={folder.relativePath}
					folder={folder}
					depth={depth}
					collapsed={collapsedFolders.has(folder.relativePath)}
					selected={selectedKeys.has(folderKey(folder.relativePath))}
					renaming={folder.relativePath === renamingFolder}
					cut={coversPath(cutFolders, folder.relativePath)}
					dropFolder={dropFolder}
					collapsedFolders={collapsedFolders}
					selectedKeys={selectedKeys}
					focusKey={focusKey}
					renamingAssetId={renamingAssetId}
					renamingFolder={renamingFolder}
					cutAssetIds={cutAssetIds}
					cutFolders={cutFolders}
					selectionDrag={selectionDrag}
					favoriteAssetIds={favoriteAssetIds}
					fileDisplay={fileDisplay}
					fileSort={fileSort}
					fileSortDirection={fileSortDirection}
					folderModifiedAt={folderModifiedAt}
					onToggleFolder={onToggleFolder}
					onSelectFolder={onSelectFolder}
					onFolderContextMenu={onFolderContextMenu}
					onRenameFolder={onRenameFolder}
					onSelectAsset={onSelectAsset}
					onAssetContextMenu={onAssetContextMenu}
					onRenameAsset={onRenameAsset}
					onCancelRename={onCancelRename}
					onDropIntoFolder={onDropIntoFolder}
					onDropFiles={onDropFiles}
					onDropFolder={onDropFolder}
				/>
			))}
			{fileDisplay === "icons" ? (
				assets.length > 0 ? (
					<div className="asset-icon-grid" style={{ marginLeft: depth * 14 }}>
						{assets.map((asset) => (
							<AssetIconTile
								key={asset.assetId}
								asset={asset}
								selected={selectedKeys.has(assetKey(asset.assetId))}
								focused={focusKey === assetKey(asset.assetId)}
								renaming={asset.assetId === renamingAssetId}
								cut={cutAssetIds.includes(asset.assetId) || coversPath(cutFolders, asset.relativePath)}
								favorite={favoriteAssetIds.has(asset.assetId)}
								selectionDrag={selectionDrag}
								onSelect={(mode) => onSelectAsset(asset.assetId, mode)}
								onContextMenu={() => onAssetContextMenu(asset)}
								onRename={(stem) => onRenameAsset(asset, stem)}
								onCancelRename={onCancelRename}
								onDropFolder={onDropFolder}
							/>
						))}
					</div>
				) : null
			) : assets.map((asset) => (
				<AssetTreeRow
					key={asset.assetId}
					asset={asset}
					depth={depth}
					selected={selectedKeys.has(assetKey(asset.assetId))}
					focused={focusKey === assetKey(asset.assetId)}
					renaming={asset.assetId === renamingAssetId}
					cut={cutAssetIds.includes(asset.assetId) || coversPath(cutFolders, asset.relativePath)}
					favorite={favoriteAssetIds.has(asset.assetId)}
					selectionDrag={selectionDrag}
					onSelect={(mode) => onSelectAsset(asset.assetId, mode)}
					onContextMenu={() => onAssetContextMenu(asset)}
					onRename={(stem) => onRenameAsset(asset, stem)}
					onCancelRename={onCancelRename}
					onDropFolder={onDropFolder}
				/>
			))}
		</>
	);
}

export interface FileTreeProps extends Omit<FileTreeRowsProps, "node" | "depth" | "dropFolder" | "onDropFolder" | "favoriteAssetIds" | "folderModifiedAt"> {
	library: LibrarySnapshot;
}

export function FolderChevronIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
			<path
				d="M6.5 5.5 9.5 8 6.5 10.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.15"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function FavoriteMark(): React.JSX.Element {
	const { t } = useLocale();
	return (
		<span className="asset-favorite" title={t.common.favorite}>
			<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
				<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
			</svg>
		</span>
	);
}

export function FileTree({ library, ...props }: FileTreeProps): React.JSX.Element {
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
	const favoriteAssetIds = useMemo(
		() => new Set(library.favoriteAssetIds ?? []),
		[library.favoriteAssetIds],
	);
	const folderModifiedAt = useMemo(() => contentModifiedAt(library.assets), [library.assets]);
	return (
		<FileTreeRows
			node={buildFileTree(library)}
			favoriteAssetIds={favoriteAssetIds}
			{...props}
			folderModifiedAt={folderModifiedAt}
			dropFolder={dropFolder}
			onDropFolder={setDropFolder}
		/>
	);
}
