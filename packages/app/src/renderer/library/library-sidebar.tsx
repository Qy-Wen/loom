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
import { AssetList } from "./asset-rows.tsx";
import { FileTree, FolderChevronIcon, LibraryRootRow } from "./file-tree.tsx";
import { TreeProvider } from "./tree-context.tsx";
import { visibleTreeRows, type PointerMode, type TreeRow } from "./tree-nav.ts";
import { sameLocation, type BrowseLocation } from "../workbench/folder-browser-model.ts";
import type { LibraryDisplay } from "./use-library-display.ts";
import { FileSortControl } from "./file-sort-control.tsx";
import { filterFavorites, filterLibrary, filterTags } from "./library-filter.ts";
import { LibraryScrollRegions } from "./library-scroll-regions.tsx";
import { WorkspaceViewIcon } from "./workspace-view-icon.tsx";

const NO_FOLDERS: ReadonlySet<string> = new Set();

interface LibrarySidebarProps {
	library: LibrarySnapshot;
	display: LibraryDisplay;
	/** Where the folder browser is. In icon mode the sidebar is its navigator. */
	location: BrowseLocation;
	onLocation: (location: BrowseLocation) => void;
	workbenchView: "library" | "table" | "graph";
	onWorkbenchView: (view: "library" | "table" | "graph") => void;
	selectedKeys: ReadonlySet<string>;
	focusKey: string | null;
	/** Changes on every selection, so a repeat click on the focused file locates it again. */
	locateToken: unknown;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	collapsedFolders: ReadonlySet<string>;
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
	display,
	location,
	onLocation,
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
	const { fileDisplay, setFileDisplay, fileSort, setFileSort, fileSortDirection, setFileSortDirection } = display;
	const iconMode = fileDisplay === "icons";
	const [searchOpen, setSearchOpen] = useState(false);
	const [favoritesCollapsed, setFavoritesCollapsed] = useState(true);
	const [tagsCollapsed, setTagsCollapsed] = useState(true);
	// In icon mode the current tag must stay visible, so Tags opens while one is the location.
	const tagsOpen = iconMode ? !tagsCollapsed || location.kind === "tag" : !tagsCollapsed;
	const [expandedTagIds, setExpandedTagIds] = useState<Set<string>>(() => new Set());
	const [typed, setQuery] = useState("");
	// The folder browser has its own search; the sidebar only filters the file tree.
	const query = iconMode ? "" : typed;
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
	const favoriteAssets = useMemo(() => filterFavorites(library, query), [library, query]);
	const visibleTags = useMemo(() => filterTags(library, query), [library, query]);
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
			onKeyDown={collapsed || iconMode ? undefined : (event) => onKeyDown(event, treeRows, !queryActive)}
		>
			<TreeProvider
				library={visible}
				foldersOnly={iconMode}
				currentFolder={iconMode && location.kind === "folder" ? location.path : null}
				fileSort={fileSort}
				fileSortDirection={fileSortDirection}
				collapsedFolders={queryActive ? NO_FOLDERS : collapsedFolders}
				selectedKeys={iconMode ? NO_FOLDERS : selectedKeys}
				focusKey={iconMode ? null : focusKey}
				locateToken={locateToken}
				renamingAssetId={iconMode ? null : renamingAssetId}
				renamingFolder={iconMode ? null : renamingFolder}
				cutAssetIds={cutAssetIds}
				cutFolders={cutFolders}
				selectionDrag={selectionDrag}
				onToggleFolder={onToggleFolder}
				onSelectFolder={(relativePath, mode) => iconMode ? onLocation({ kind: "folder", path: relativePath }) : onSelectFolder(relativePath, mode, treeRows)}
				onFolderContextMenu={onFolderContextMenu}
				onRenameFolder={onRenameFolder}
				onSelectAsset={(assetId, mode) => onSelectAsset(assetId, mode, treeRows)}
				onOpenAssetInTab={onOpenAssetInTab}
				onAssetContextMenu={onAssetContextMenu}
				onRenameAsset={onRenameAsset}
				onCancelRename={onCancelRename}
				onDropIntoFolder={onDropIntoFolder}
				onDropFiles={onDropFiles}
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
						<WorkspaceViewIcon view={view} />
						<span>{t.library[view]}</span>
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
						{iconMode ? null : (
							<FileSortControl
								sort={fileSort}
								direction={fileSortDirection}
								onSort={setFileSort}
								onDirection={setFileSortDirection}
							/>
						)}
						{iconMode ? null : (
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
						)}
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
						</>
					) : null}
				</span>
			</div>
			{searchOpen && !iconMode && library.rootPath ? (
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
					shortcuts={iconMode ? (!empty && (library.favoriteAssetIds.length > 0 || library.tags.length > 0) ? (
						<div className="library-nav">
							{library.favoriteAssetIds.length > 0 ? (
								<button
									type="button"
									className={`favorites-label${sameLocation(location, { kind: "favorites" }) ? " selected" : ""}`}
									onClick={() => onLocation({ kind: "favorites" })}
								>
									<span className="folder-chevron-spacer" aria-hidden="true" />
									<span className="favorites-main">
										<span className="favorites-symbol" aria-hidden="true">
											<svg viewBox="0 0 16 16" width="16" height="16">
												<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
											</svg>
										</span>
										{t.library.favorites}
									</span>
								</button>
							) : null}
							{library.tags.length > 0 ? (
								<div className="library-tags">
									<button
										type="button"
										className="tags-label"
										aria-expanded={tagsOpen}
										onClick={() => setTagsCollapsed(tagsOpen)}
									>
										<span className={`folder-chevron${tagsOpen ? " expanded" : ""}`} aria-hidden="true"><FolderChevronIcon /></span>
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
									{tagsOpen ? library.tags.map((tag) => (
										<button
											key={tag.tagId}
											type="button"
											className={`library-nav-item tag-item${sameLocation(location, { kind: "tag", tagId: tag.tagId }) ? " selected" : ""}`}
											onClick={() => onLocation({ kind: "tag", tagId: tag.tagId })}
										>
											<span className="asset-name">{tag.name}</span>
										</button>
									)) : null}
								</div>
							) : null}
						</div>
					) : null) : !empty && (favoriteAssets.length > 0 || visibleTags.length > 0) ? <>
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
								{queryActive || !favoritesCollapsed ? <AssetList assets={favoriteAssets} depth={0} quiet /> : null}
							</div>
						) : null}
						{visibleTags.length > 0 ? (
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
											{open ? <AssetList assets={files} depth={2} quiet /> : null}
										</div>
									);
								}) : null}
							</div>
						) : null}
					</> : null}
				>
					{empty && !iconMode ? <div className="empty" onContextMenu={(event) => { event.preventDefault(); onLibraryContextMenu(); }}>{t.library.emptyFolder}</div> : queryActive && visible.assets.length === 0 && visible.folders.length === 0 ? (
						<div className="empty">{t.common.noMatchingFiles}</div>
					) : (
						<>
							{iconMode ? (
								<LibraryRootRow
									name={library.rootPath?.split(/[/\\]/).filter(Boolean).at(-1) ?? t.library.noFolder}
									selected={location.kind === "folder" && location.path === ""}
									onOpen={() => onLocation({ kind: "folder", path: "" })}
								/>
							) : null}
							<FileTree library={visible} />
						</>
					)}
				</LibraryScrollRegions>
			)}
			</div>
			</TreeProvider>
		</aside>
	);
}

