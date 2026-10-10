import { useEffect, useMemo, useRef, useState } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	readLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";
import { AssetThumbnail } from "../assets/asset-thumbnail.tsx";
import { useLocale } from "../locale.tsx";
import { FileTree, type FileDisplay } from "./file-tree.tsx";
import { visibleTreeRows, type TreeRow } from "./tree-nav.ts";

const FILE_DISPLAY_KEY = "loom.library.fileDisplay";

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

interface LibrarySidebarProps {
	library: LibrarySnapshot;
	opening: boolean;
	workbenchView: "library" | "table" | "graph";
	onWorkbenchView: (view: "library" | "table" | "graph") => void;
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
	onKeyDown: (event: React.KeyboardEvent, rows: readonly TreeRow[], folding: boolean) => void;
	onOpenSettings: () => void;
	onOpenTraces?: () => void;
}

export function LibrarySidebar({
	library,
	opening,
	workbenchView,
	onWorkbenchView,
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
	onOpenSettings,
	onOpenTraces,
}: LibrarySidebarProps): React.JSX.Element {
	const { t } = useLocale();
	const empty = library.assets.length === 0 && library.folders.length === 0;
	const [fileDisplay, setFileDisplay] = useState<FileDisplay>(() => (
		localStorage.getItem(FILE_DISPLAY_KEY) === "icons" ? "icons" : "list"
	));
	useEffect(() => {
		localStorage.setItem(FILE_DISPLAY_KEY, fileDisplay);
	}, [fileDisplay]);
	const [searchOpen, setSearchOpen] = useState(false);
	const [favoritesCollapsed, setFavoritesCollapsed] = useState(true);
	const [tagsCollapsed, setTagsCollapsed] = useState(true);
	const [expandedTagIds, setExpandedTagIds] = useState<Set<string>>(() => new Set());
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const visible = useMemo(() => filterLibrary(library, query), [library, query]);
	const queryActive = query.trim().length > 0;
	const treeRows = useMemo(
		() => visibleTreeRows(visible.folders, visible.assets, queryActive ? new Set() : collapsedFolders),
		[visible, queryActive, collapsedFolders],
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

	function acceptRootDrop(event: React.DragEvent): boolean {
		if (!hasLibraryDrag(event.dataTransfer) || !canDropLibraryItem("", activeLibraryDrag())) return false;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		return true;
	}

	return (
		<aside className="library-sidebar" tabIndex={0} onKeyDown={(event) => onKeyDown(event, treeRows, !queryActive)}>
			<div className="library-header">
				<div>
					<div className="section-label">Loom</div>
					<div className="library-name" title={library.rootPath ?? undefined}>
						{library.rootPath?.split(/[/\\]/).filter(Boolean).at(-1) ?? t.library.noFolder}
					</div>
				</div>
				<button className="open-button" type="button" onClick={onOpenLibrary} disabled={opening}>
					{opening ? "…" : t.common.open}
				</button>
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
							{t.library.emptyFolder}
						</div>
					) : (
						<>
						{favoriteAssets.length > 0 ? (
							<div className="favorites">
								<button
									type="button"
									className="favorites-label"
									aria-expanded={queryActive || !favoritesCollapsed}
									onClick={() => setFavoritesCollapsed(queryActive || !favoritesCollapsed)}
								>
									<span className={`folder-chevron${queryActive || !favoritesCollapsed ? " expanded" : ""}`} aria-hidden="true">›</span>
									<span className="favorites-main">
										<span className="favorites-symbol" aria-hidden="true">
											<svg viewBox="0 0 16 16" width="16" height="16">
												<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
											</svg>
										</span>
										{t.library.favorites}
									</span>
								</button>
								{queryActive || !favoritesCollapsed ? favoriteAssets.map((asset) => (
									<button
										key={asset.assetId}
										type="button"
										className={`asset-row${asset.assetId === selectedAssetId ? " selected" : ""}`}
										onClick={() => onSelectAsset(asset.assetId)}
										onContextMenu={(event) => {
											event.preventDefault();
											onAssetContextMenu(asset);
										}}
									>
										<AssetThumbnail asset={asset} />
										<span className="asset-name" title={asset.relativePath}>{asset.filename}</span>
										<span className="asset-favorite" title={t.common.favorite}>
											<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
												<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
											</svg>
										</span>
									</button>
								)) : null}
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
									<span className={`folder-chevron${queryActive || !tagsCollapsed ? " expanded" : ""}`} aria-hidden="true">›</span>
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
													›
												</button>
												<button
													className="folder-main"
													type="button"
													onClick={() => toggleTag(tag.tagId)}
												>
													<span className="asset-name">{tag.name}</span>
												</button>
											</div>
											{open ? files.map((asset) => (
												<button
													key={asset.assetId}
													type="button"
													className={`asset-row${asset.assetId === selectedAssetId ? " selected" : ""}`}
													style={{ paddingLeft: 35 }}
													onClick={() => onSelectAsset(asset.assetId)}
													onContextMenu={(event) => {
														event.preventDefault();
														onAssetContextMenu(asset);
													}}
												>
													<AssetThumbnail asset={asset} />
													<span className="asset-name" title={asset.relativePath}>{asset.filename}</span>
													{library.favoriteAssetIds.includes(asset.assetId) ? (
														<span className="asset-favorite" title={t.common.favorite}>
															<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
																<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
															</svg>
														</span>
													) : null}
												</button>
											)) : null}
										</div>
									);
								}) : null}
							</div>
						) : null}
						{queryActive && visible.assets.length === 0 && visible.folders.length === 0 ? (
							<div className="empty">{t.common.noMatchingFiles}</div>
						) : (
						<FileTree
							library={visible}
							fileDisplay={fileDisplay}
							collapsedFolders={queryActive ? new Set() : collapsedFolders}
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
						</>
					)}
				</div>
			)}
			<div className="library-footer">
				{onOpenTraces ? (
					<button type="button" aria-label={t.library.traces} title={t.library.traces} onClick={onOpenTraces}>
						<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
							<path d="M2 12.5h12M3.5 10.5 6.2 7l2.2 2.2 3.6-4.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</button>
				) : null}
				<button type="button" aria-label={t.common.settings} title={t.common.settings} onClick={onOpenSettings}>
					<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
						<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
			</div>
		</aside>
	);
}
