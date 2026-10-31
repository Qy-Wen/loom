import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	hasOsFileDrag,
	readLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";
import { useLocale } from "../locale.tsx";
import { AssetIconTile, AssetTreeRow, FileTree, FolderChevronIcon, type FileDisplay } from "./file-tree.tsx";
import { assetKey, coversPath, visibleTreeRows, type FileSort, type FileSortDirection, type PointerMode, type TreeRow } from "./tree-nav.ts";
import { LibraryScrollRegions } from "./library-scroll-regions.tsx";

const FILE_DISPLAY_KEY = "loom.library.fileDisplay";
const FILE_SORT_KEY = "loom.library.fileSort";
const FILE_SORT_DIRECTION_KEY = "loom.library.fileSortDirection";

function storedFileSort(): FileSort {
	return localStorage.getItem(FILE_SORT_KEY) === "modified" ? "modified" : "name";
}

function storedFileSortDirection(): FileSortDirection {
	const stored = localStorage.getItem(FILE_SORT_DIRECTION_KEY);
	if (stored === "asc" || stored === "desc") return stored;
	return storedFileSort() === "modified" ? "desc" : "asc";
}

function folderNameMatches(folder: string, query: string): boolean {
	return (folder.split("/").at(-1) ?? folder).toLowerCase().includes(query);
}

function addFolderChain(folders: Set<string>, folder: string): void {
	const parts = folder.split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		folders.add(current);
	}
}

function filterLibrary(library: LibrarySnapshot, query: string): LibrarySnapshot {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return library;
	const named = library.folders.filter((folder) => folderNameMatches(folder, normalized));
	const assets = library.assets.filter((asset) => (
		asset.filename.toLowerCase().includes(normalized)
		|| asset.relativePath.toLowerCase().includes(normalized)
		|| named.some((folder) => asset.relativePath.startsWith(`${folder}/`))
	));
	const folders = new Set<string>();
	for (const folder of named) addFolderChain(folders, folder);
	for (const folder of library.folders) {
		if (named.some((hit) => folder.startsWith(`${hit}/`))) addFolderChain(folders, folder);
	}
	for (const asset of assets) {
		const parent = asset.relativePath.split("/").slice(0, -1).join("/");
		if (parent) addFolderChain(folders, parent);
	}
	return { ...library, assets, folders: [...folders] };
}

function filesForTag(library: LibrarySnapshot, tagId: string): Asset[] {
	const byId = new Map(library.assets.map((asset) => [asset.assetId, asset]));
	return library.assetTags.flatMap((row) => {
		if (row.tagId !== tagId) return [];
		const asset = byId.get(row.assetId);
		return asset ? [asset] : [];
	});
}

function NameSortIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<path d="M3.2 12.6 8 3.2l4.8 9.4M5.2 9.2h5.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ModifiedSortIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			<circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.3" />
			<path d="M8 4.8V8.2l2.2 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function FileSortControl({
	sort,
	direction,
	onSort,
	onDirection,
}: {
	sort: FileSort;
	direction: FileSortDirection;
	onSort: (sort: FileSort) => void;
	onDirection: (direction: FileSortDirection) => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement>(null);
	const directionLabel = direction === "asc" ? t.library.sortAscending : t.library.sortDescending;

	useEffect(() => {
		if (!open) return;
		const close = (event: PointerEvent) => {
			if (rootRef.current?.contains(event.target as Node)) return;
			setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		window.addEventListener("pointerdown", close);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<span className="file-sort" ref={rootRef}>
			<button
				type="button"
				className={open ? "active" : ""}
				aria-label={t.library.sortFiles}
				aria-haspopup="menu"
				aria-expanded={open}
				title={sort === "name" ? t.library.sortByName : t.library.sortByModified}
				onClick={() => setOpen((current) => !current)}
			>
				{sort === "name" ? <NameSortIcon /> : <ModifiedSortIcon />}
			</button>
			<button
				type="button"
				aria-label={directionLabel}
				title={directionLabel}
				onClick={() => {
					setOpen(false);
					onDirection(direction === "asc" ? "desc" : "asc");
				}}
			>
				<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
					<path
						d={direction === "asc" ? "M8 3.2v9.6M5.2 6 8 3.2 10.8 6" : "M8 12.8V3.2M5.2 10 8 12.8 10.8 10"}
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open ? (
				<span className="file-sort-menu" role="menu" aria-label={t.library.sortFiles}>
					<button
						type="button"
						role="menuitemradio"
						aria-checked={sort === "name"}
						onClick={() => {
							onSort("name");
							setOpen(false);
						}}
					>
						{t.library.sortByName}
					</button>
					<button
						type="button"
						role="menuitemradio"
						aria-checked={sort === "modified"}
						onClick={() => {
							onSort("modified");
							setOpen(false);
						}}
					>
						{t.library.sortByModified}
					</button>
				</span>
			) : null}
		</span>
	);
}

interface LibrarySidebarProps {
	library: LibrarySnapshot;
	workbenchView: "library" | "table" | "graph";
	onWorkbenchView: (view: "library" | "table" | "graph") => void;
	selectedKeys: ReadonlySet<string>;
	focusKey: string | null;
	/** Changes on every selection, so a repeat click on the focused file locates it again. */
	locateToken: unknown;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	collapsedFolders: Set<string>;
	cutAssetIds: readonly string[];
	cutFolders: readonly string[];
	selectionDrag: LibraryDrag | null;
	onToggleFolder: (relativePath: string) => void;
	onSelectAsset: (assetId: string, mode: PointerMode, rows: readonly TreeRow[]) => void;
	onOpenAssetInTab: (assetId: string) => void;
	onSelectFolder: (relativePath: string, mode: PointerMode, rows: readonly TreeRow[]) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onLibraryContextMenu: () => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFiles: (destFolder: string, files: File[]) => void;
	onKeyDown: (event: React.KeyboardEvent, rows: readonly TreeRow[], folding: boolean) => void;
	collapsed: boolean;
}

export function LibrarySidebar({
	library,
	workbenchView,
	onWorkbenchView,
	selectedKeys,
	focusKey,
	locateToken,
	renamingAssetId,
	renamingFolder,
	collapsedFolders,
	cutAssetIds,
	cutFolders,
	selectionDrag,
	onToggleFolder,
	onSelectAsset,
	onOpenAssetInTab,
	onSelectFolder,
	onAssetContextMenu,
	onFolderContextMenu,
	onLibraryContextMenu,
	onRenameAsset,
	onRenameFolder,
	onCancelRename,
	onDropIntoFolder,
	onDropFiles,
	onKeyDown,
	collapsed,
}: LibrarySidebarProps): React.JSX.Element {
	const { t } = useLocale();
	const empty = library.assets.length === 0 && library.folders.length === 0;
	const [fileDisplay, setFileDisplay] = useState<FileDisplay>(() => (
		localStorage.getItem(FILE_DISPLAY_KEY) === "icons" ? "icons" : "list"
	));
	useEffect(() => {
		localStorage.setItem(FILE_DISPLAY_KEY, fileDisplay);
	}, [fileDisplay]);
	const [fileSort, setFileSort] = useState<FileSort>(storedFileSort);
	const [fileSortDirection, setFileSortDirection] = useState<FileSortDirection>(storedFileSortDirection);
	useEffect(() => {
		localStorage.setItem(FILE_SORT_KEY, fileSort);
	}, [fileSort]);
	useEffect(() => {
		localStorage.setItem(FILE_SORT_DIRECTION_KEY, fileSortDirection);
	}, [fileSortDirection]);
	const [searchOpen, setSearchOpen] = useState(false);
	const [favoritesCollapsed, setFavoritesCollapsed] = useState(true);
	const [tagsCollapsed, setTagsCollapsed] = useState(true);
	const [expandedTagIds, setExpandedTagIds] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const visible = useMemo(() => filterLibrary(library, query), [library, query]);
	const queryActive = query.trim().length > 0;
	const treeRows = useMemo(
		() => visibleTreeRows(
			visible.folders,
			visible.assets,
			queryActive ? new Set() : collapsedFolders,
			fileSort,
			fileSortDirection,
		),
		[visible, queryActive, collapsedFolders, fileSort, fileSortDirection],
	);
	const favoriteAssets = useMemo(() => {
		const byId = new Map(library.assets.map((asset) => [asset.assetId, asset]));
		const normalized = query.trim().toLowerCase();
		return (library.favoriteAssetIds ?? []).flatMap((assetId) => {
			const asset = byId.get(assetId);
			if (!asset) return [];
			if (normalized && !asset.filename.toLowerCase().includes(normalized) && !asset.relativePath.toLowerCase().includes(normalized)) return [];
			return [asset];
		});
	}, [library, query]);
	const visibleTags = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return library.tags.map((tag) => ({ tag, files: filesForTag(library, tag.tagId) }));
		return library.tags.flatMap((tag) => {
			const files = filesForTag(library, tag.tagId);
			const nameHit = tag.name.toLowerCase().includes(normalized);
			const matched = nameHit ? files : files.filter((asset) => (
				asset.filename.toLowerCase().includes(normalized) || asset.relativePath.toLowerCase().includes(normalized)
			));
			return matched.length > 0 || nameHit ? [{ tag, files: matched.length > 0 ? matched : files }] : [];
		});
	}, [library, query]);
	useEffect(() => {
		if (searchOpen) searchRef.current?.focus();
	}, [searchOpen]);
	useEffect(() => {
		setSearchOpen(false);
		setQuery("");
		setExpandedTagIds(new Set());
	}, [library.rootPath]);

	function toggleTag(tagId: string): void {
		setExpandedTagIds((current) => {
			const next = new Set(current);
			if (next.has(tagId)) next.delete(tagId);
			else next.add(tagId);
			return next;
		});
	}

	function shortcutFiles(assets: readonly Asset[], depth = 0): React.JSX.Element {
		const items = assets.map((asset) => {
			const props = {
				asset,
				selected: selectedKeys.has(assetKey(asset.assetId)),
				// Shortcuts must not auto-scroll to another copy of the same file or host duplicate rename editors.
				focused: false,
				renaming: false,
				cut: cutAssetIds.includes(asset.assetId) || coversPath(cutFolders, asset.relativePath),
				favorite: library.favoriteAssetIds.includes(asset.assetId),
				selectionDrag,
				onSelect: (mode: PointerMode) => onSelectAsset(asset.assetId, mode, treeRows),
				onOpenInTab: () => onOpenAssetInTab(asset.assetId),
				onContextMenu: () => onAssetContextMenu(asset),
				onRename: (stem: string) => onRenameAsset(asset, stem),
				onCancelRename,
				onDropFolder: () => {},
			};
			return fileDisplay === "icons" ? <AssetIconTile key={asset.assetId} {...props} /> : <AssetTreeRow key={asset.assetId} depth={depth} {...props} />;
		});
		return fileDisplay === "icons" && items.length > 0 ? <div className="asset-icon-grid" style={{ marginLeft: depth * 14 }}>{items}</div> : <>{items}</>;
	}

	function acceptRootDrop(event: React.DragEvent): boolean {
		if (!hasLibraryDrag(event.dataTransfer) || !canDropLibraryItem("", activeLibraryDrag())) return false;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		return true;
	}

	return (
		<aside
			className={collapsed ? "library-sidebar collapsed" : "library-sidebar"}
			inert={collapsed}
			aria-hidden={collapsed || undefined}
			tabIndex={collapsed ? undefined : 0}
			onKeyDown={collapsed ? undefined : (event) => onKeyDown(event, treeRows, !queryActive)}
		>
			<div className="library-sidebar-content">
			<div className="library-header">
				<span className="section-label">Loom</span>
				<span className="library-header-rule" aria-hidden="true" />
				<span className="library-name" title={library.rootPath ?? undefined}>
					{library.rootPath?.split(/[/\\]/).filter(Boolean).at(-1) ?? t.library.noFolder}
				</span>
			</div>

			<nav className="library-views" aria-label={t.library.views}>
				{(["library", "table", "graph"] as const).map((view) => (
					<button
						key={view}
						type="button"
						className={workbenchView === view ? "active" : ""}
						aria-pressed={workbenchView === view}
						onClick={() => onWorkbenchView(view)}
					>
						{t.library[view]}
					</button>
				))}
			</nav>

			<div className="file-heading">
				<span className="file-heading-title">
					<span>{t.library.files}</span>
					<span>{queryActive ? visible.assets.length : library.assets.length}</span>
				</span>
				<span className="file-heading-tools">
					{library.rootPath ? (
						<>
						<FileSortControl
							sort={fileSort}
							direction={fileSortDirection}
							onSort={setFileSort}
							onDirection={setFileSortDirection}
						/>
						<span className="file-display" role="group" aria-label={t.library.fileDisplay}>
							<button
								type="button"
								className={fileDisplay === "list" ? "active" : ""}
								aria-label={t.library.list}
								aria-pressed={fileDisplay === "list"}
								title={t.library.list}
								onClick={() => setFileDisplay("list")}
							>
								<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
									<path d="M2.5 4h11M2.5 8h11M2.5 12h11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
								</svg>
							</button>
							<button
								type="button"
								className={fileDisplay === "icons" ? "active" : ""}
								aria-label={t.library.icons}
								aria-pressed={fileDisplay === "icons"}
								title={t.library.icons}
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
						<button
							type="button"
							className={searchOpen ? "active" : ""}
							aria-label={t.common.searchFiles}
							aria-pressed={searchOpen}
							title={t.common.searchFiles}
							onClick={() => {
								setSearchOpen((open) => {
									if (open) setQuery("");
									return !open;
								});
							}}
						>
							<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
								<circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
								<path d="M10.2 10.2 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
							</svg>
						</button>
						</>
					) : null}
				</span>
			</div>
			{searchOpen && library.rootPath ? (
				<div className="file-search">
					<input
						ref={searchRef}
						type="search"
						placeholder={t.library.filterFiles}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							event.preventDefault();
							setQuery("");
							setSearchOpen(false);
						}}
					/>
				</div>
			) : null}
			{!library.rootPath ? (
				<div className="empty library-placeholder">{t.library.openFolderHint}</div>
			) : (
				<LibraryScrollRegions
					label={t.library.resizeRegions}
					moreHint={t.library.moreShortcuts}
					filesProps={{
						onDragOver: (event) => {
							if (hasOsFileDrag(event.dataTransfer)) {
								event.preventDefault();
								event.dataTransfer.dropEffect = "copy";
								return;
							}
							acceptRootDrop(event);
						},
						onDrop: (event) => {
							if (hasOsFileDrag(event.dataTransfer)) {
								event.preventDefault();
								const files = [...event.dataTransfer.files];
								if (files.length > 0) onDropFiles("", files);
								return;
							}
							if (!acceptRootDrop(event)) return;
							const item = readLibraryDrag(event.dataTransfer);
							endLibraryDrag();
							if (item) onDropIntoFolder("", item);
						},
						onContextMenu: (event) => {
							if (event.target !== event.currentTarget) return;
							event.preventDefault();
							onLibraryContextMenu();
						},
					}}
					shortcuts={!empty && (favoriteAssets.length > 0 || library.tags.length > 0) ? <>
						{favoriteAssets.length > 0 ? (
							<div className="favorites">
								<button
									type="button"
									className="favorites-label"
									aria-expanded={queryActive || !favoritesCollapsed}
									onClick={() => setFavoritesCollapsed(queryActive || !favoritesCollapsed)}
								>
									<span className={`folder-chevron${queryActive || !favoritesCollapsed ? " expanded" : ""}`} aria-hidden="true"><FolderChevronIcon /></span>
									<span className="favorites-main">
										<span className="favorites-symbol" aria-hidden="true">
											<svg viewBox="0 0 16 16" width="16" height="16">
												<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
											</svg>
										</span>
										{t.library.favorites}
									</span>
								</button>
								{queryActive || !favoritesCollapsed ? shortcutFiles(favoriteAssets) : null}
							</div>
						) : null}
						{library.tags.length > 0 ? (
							<div className="library-tags">
								<button
									type="button"
									className="tags-label"
									aria-expanded={queryActive || !tagsCollapsed}
									onClick={() => setTagsCollapsed(queryActive || !tagsCollapsed)}
								>
									<span className={`folder-chevron${queryActive || !tagsCollapsed ? " expanded" : ""}`} aria-hidden="true"><FolderChevronIcon /></span>
									<span className="tags-main">
										<span className="tags-symbol" aria-hidden="true">
											<svg viewBox="0 0 16 16" width="16" height="16">
												<path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M2.5 8.2 8 2.7h5.2V8l-5.6 5.4a1.2 1.2 0 0 1-1.7 0L2.5 9.6a1 1 0 0 1 0-1.4Z" />
												<circle cx="10.4" cy="5.2" r="0.8" fill="currentColor" stroke="none" />
											</svg>
										</span>
										{t.library.tags}
									</span>
								</button>
								{queryActive || !tagsCollapsed ? visibleTags.map(({ tag, files }) => {
									const open = queryActive || expandedTagIds.has(tag.tagId);
									return (
										<div key={tag.tagId}>
											<div className="folder-row" style={{ paddingLeft: 21 }}>
												<button
													className={`folder-chevron${open ? " expanded" : ""}`}
													type="button"
													aria-label={open ? t.library.collapseTag : t.library.expandTag}
													onClick={() => toggleTag(tag.tagId)}
												>
													<FolderChevronIcon />
												</button>
												<button
													className="folder-main"
													type="button"
													onClick={() => toggleTag(tag.tagId)}
												>
													<span className="asset-name">{tag.name}</span>
												</button>
											</div>
											{open ? shortcutFiles(files, 2) : null}
										</div>
									);
								}) : null}
							</div>
						) : null}
					</> : null}
				>
					{empty ? <div className="empty" onContextMenu={(event) => { event.preventDefault(); onLibraryContextMenu(); }}>{t.library.emptyFolder}</div> : queryActive && visible.assets.length === 0 && visible.folders.length === 0 ? (
						<div className="empty">{t.common.noMatchingFiles}</div>
					) : (
						<FileTree
							library={visible}
							fileDisplay={fileDisplay}
							fileSort={fileSort}
							fileSortDirection={fileSortDirection}
							collapsedFolders={queryActive ? new Set() : collapsedFolders}
							selectedKeys={selectedKeys}
							focusKey={focusKey}
							locateToken={locateToken}
							renamingAssetId={renamingAssetId}
							renamingFolder={renamingFolder}
							cutAssetIds={cutAssetIds}
							cutFolders={cutFolders}
							selectionDrag={selectionDrag}
							onToggleFolder={onToggleFolder}
							onSelectFolder={(relativePath, mode) => onSelectFolder(relativePath, mode, treeRows)}
							onFolderContextMenu={onFolderContextMenu}
							onRenameFolder={onRenameFolder}
							onSelectAsset={(assetId, mode) => onSelectAsset(assetId, mode, treeRows)}
							onOpenAssetInTab={onOpenAssetInTab}
							onAssetContextMenu={onAssetContextMenu}
							onRenameAsset={onRenameAsset}
							onCancelRename={onCancelRename}
							onDropIntoFolder={onDropIntoFolder}
							onDropFiles={onDropFiles}
						/>
					)}
				</LibraryScrollRegions>
			)}
			</div>
		</aside>
	);
}

export function SettingsButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.common.settings} onClick={onOpen}>
			<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
				<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</button>
	);
}

export function HelpButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.help.title} onClick={onOpen}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
				<path d="M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
				<circle cx="8" cy="11.5" r=".85" fill="currentColor" />
			</svg>
		</button>
	);
}

export function TracesButton({ onOpen }: { onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.library.traces} onClick={onOpen}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path d="M2 12.5h12M3.5 10.5 6.2 7l2.2 2.2 3.6-4.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
			</svg>
		</button>
	);
}

export function LibraryOpenButton({ opening, onOpen }: { opening: boolean; onOpen: () => void }): React.JSX.Element {
	const { t } = useLocale();
	return (
		<button className="library-collapse" type="button" aria-label={t.common.open} onClick={onOpen} disabled={opening}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M1.8 6.2 3.2 3.6h3.4l1.1 1.3h5.5v1.3" />
				<path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" d="M1.8 6.4h12.4l-1.3 6.1H3.1L1.8 6.4z" />
			</svg>
		</button>
	);
}

export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }): React.JSX.Element {
	const { t } = useLocale();
	const label = collapsed ? t.library.expandSidebar : t.library.collapseSidebar;
	return (
		<button className="library-collapse" type="button" aria-label={label} onClick={onToggle}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
				<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
				<path d="M5.7 2.8v10.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
			</svg>
		</button>
	);
}
