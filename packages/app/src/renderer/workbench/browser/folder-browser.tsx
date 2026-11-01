import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import { endLibraryDrag, hasLibraryDrag, hasOsFileDrag, readLibraryDrag, type LibraryDrag } from "../../assets/asset-drag.ts";
import { FileSortControl } from "../../library/file-sort-control.tsx";
import { FolderChevronIcon } from "../../library/file-tree.tsx";
import { folderDropProps, useDropFolder } from "../../library/folder-drop.ts";
import type { LibraryDisplay } from "../../library/use-library-display.ts";
import { assetKey, folderKey, parentFolder, rowKey, selectRange, singleSelection, type PointerMode, type TreeRow, type TreeSelection } from "../../library/tree-nav.ts";
import { useLocale } from "../../locale.tsx";
import { AssetTile, FolderTile, type TileContext } from "./browser-tiles.tsx";
import { browserRows, browseListing, folderCrumbs, gridMove, isGridKey, type BrowseLocation } from "./folder-browser-model.ts";
import { useBoxSelect } from "./use-box-select.ts";
import { BrowserIconSizeControl } from "./browser-icon-size-control.tsx";
import { useBrowserIconSize } from "./use-browser-icon-size.ts";
import { browserFolderPreviews } from "./browser-folder-preview.ts";

export interface FolderBrowserProps {
	library: LibrarySnapshot;
	location: BrowseLocation;
	onLocation: (location: BrowseLocation) => void;
	display: LibraryDisplay;
	selection: TreeSelection;
	onSelection: (selection: TreeSelection) => void;
	onSelect: (key: string, mode: PointerMode, rows: readonly TreeRow[]) => void;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	cutAssetIds: readonly string[];
	cutFolders: readonly string[];
	selectionDrag: LibraryDrag | null;
	onOpenAsset: (assetId: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onLibraryContextMenu: () => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onCancelRename: () => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFiles: (destFolder: string, files: File[]) => void;
	/** Shared shortcuts (copy, paste, delete, rename, select all). Arrow keys are handled here. */
	onKeyDown: (event: React.KeyboardEvent, rows: readonly TreeRow[], folding: boolean) => void;
	/** The file preview overlay, drawn over the browser. */
	children?: ReactNode;
}

function tileColumns(content: HTMLElement): number {
	const tiles = content.querySelectorAll<HTMLElement>("[data-key]");
	if (tiles.length === 0) return 1;
	const top = tiles[0].offsetTop;
	let columns = 0;
	for (const tile of tiles) {
		if (tile.offsetTop !== top) break;
		columns += 1;
	}
	return columns;
}

/** The icon-mode workbench: the contents of one folder (or the favorites / a tag) as tiles, with a path bar and search. */
export function FolderBrowser(props: FolderBrowserProps): React.JSX.Element {
	const { library, location, onLocation, display, selection, onSelection, onSelect } = props;
	const { t } = useLocale();
	const [iconSize, setIconSize] = useBrowserIconSize();
	const [query, setQuery] = useState("");
	const [dropFolder, onDropFolder] = useDropFolder();
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const searching = query.trim().length > 0;
	const base = location.kind === "folder" ? location.path : "";
	const locationId = location.kind === "folder" ? `folder:${location.path}` : location.kind === "tag" ? `tag:${location.tagId}` : "favorites";
	useEffect(() => setQuery(""), [locationId, library.rootPath]);

	const listing = useMemo(
		() => browseListing(library, location, query, display.fileSort, display.fileSortDirection),
		[library, location, query, display.fileSort, display.fileSortDirection],
	);
	const rows = useMemo(() => browserRows(listing), [listing]);
	const folderPreviews = useMemo(() => browserFolderPreviews(library), [library.assets, library.folders]);
	const selectedKeys = useMemo(() => new Set(selection.keys), [selection.keys]);
	const favoriteAssetIds = useMemo(() => new Set(library.favoriteAssetIds), [library.favoriteAssetIds]);
	const rootName = library.rootPath?.split(/[/\\]/).filter(Boolean).at(-1) ?? t.library.noFolder;
	const tag = location.kind === "tag" ? library.tags.find((item) => item.tagId === location.tagId) : undefined;
	const where = location.kind === "favorites" ? t.library.favorites : location.kind === "tag" ? (tag?.name ?? "") : (base ? base.slice(base.lastIndexOf("/") + 1) : rootName);

	const { box, onPointerDown } = useBoxSelect({ scrollRef, contentRef, selection, onSelection });

	// Keep the focused tile in view as the arrow keys move it.
	useLayoutEffect(() => {
		if (!selection.focus) return;
		for (const element of contentRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []) {
			if (element.dataset.key === selection.focus) element.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	}, [selection.focus, locationId]);

	const context: TileContext = {
		selectedKeys,
		cutAssetIds: props.cutAssetIds,
		cutFolders: props.cutFolders,
		favoriteAssetIds,
		selectionDrag: props.selectionDrag,
		renamingAssetId: props.renamingAssetId,
		renamingFolder: props.renamingFolder,
		dropFolder,
		onDropFolder,
		onDropIntoFolder: props.onDropIntoFolder,
		onDropFiles: props.onDropFiles,
		onSelect: (key, mode) => onSelect(key, mode, rows),
		onOpenAsset: props.onOpenAsset,
		onOpenFolder: (path) => onLocation({ kind: "folder", path }),
		onAssetContextMenu: props.onAssetContextMenu,
		onFolderContextMenu: props.onFolderContextMenu,
		onRenameAsset: props.onRenameAsset,
		onRenameFolder: props.onRenameFolder,
		onCancelRename: props.onCancelRename,
	};

	function goUp(): void {
		if (location.kind === "folder" && location.path) onLocation({ kind: "folder", path: parentFolder(location.path) });
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		const mod = event.metaKey || event.ctrlKey;
		if (!mod && !event.altKey) {
			const current = rows.findIndex((row) => rowKey(row) === selection.focus);
			if (isGridKey(event.key)) {
				event.preventDefault();
				event.currentTarget.focus();
				const columns = contentRef.current ? tileColumns(contentRef.current) : 1;
				const next = gridMove(current, event.key, columns, rows.length);
				if (next < 0) return;
				const key = rowKey(rows[next]);
				onSelection(event.shiftKey ? selectRange(selection, rows, key) : singleSelection(key));
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				const row = rows[current];
				if (!row) return;
				if (row.kind === "folder") onLocation({ kind: "folder", path: row.relativePath });
				else if (row.assetId) props.onOpenAsset(row.assetId);
				return;
			}
			if (event.key === "Backspace" && !event.shiftKey) {
				event.preventDefault();
				goUp();
				return;
			}
		}
		props.onKeyDown(event, rows, false);
	}

	const crumbs: { label: string; target: BrowseLocation | null; drop: string | null }[] = [{ label: rootName, target: { kind: "folder", path: "" }, drop: "" }];
	if (location.kind === "folder") {
		for (const crumb of folderCrumbs(location.path)) crumbs.push({ label: crumb.name, target: { kind: "folder", path: crumb.path }, drop: crumb.path });
	} else {
		crumbs.push({ label: where, target: null, drop: null });
	}
	const emptyText = searching ? t.browser.noMatches
		: location.kind === "favorites" ? t.browser.noFavorites
			: location.kind === "tag" ? t.browser.noTagged : t.browser.empty;
	const count = rows.length;
	const dropHere = location.kind === "folder" && dropFolder === location.path;
	const dropPath = location.kind === "folder" ? location.path : "";

	return (
		<section className="folder-browser" aria-label={t.browser.label} style={{ "--browser-icon-size": `${iconSize}px` } as CSSProperties}>
			<header className="browser-bar">
				<nav className="browser-crumbs" aria-label={t.browser.path}>
					{crumbs.map((crumb, index) => {
						const last = index === crumbs.length - 1;
						return (
							<span className="browser-crumb-item" key={`${index}:${crumb.label}`}>
								{index > 0 ? <span className="browser-crumb-sep" aria-hidden="true"><FolderChevronIcon /></span> : null}
								{crumb.target && !last ? (
									<button
										type="button"
										className={`browser-crumb${crumb.drop !== null && dropFolder === crumb.drop ? " drop-target" : ""}`}
										onClick={() => onLocation(crumb.target!)}
										{...(crumb.drop !== null ? folderDropProps(crumb.drop, { dropFolder, onDropFolder, onDropIntoFolder: props.onDropIntoFolder, onDropFiles: props.onDropFiles }) : {})}
									>
										{crumb.label}
									</button>
								) : (
									<span className="browser-crumb current" aria-current="location">{crumb.label}</span>
								)}
							</span>
						);
					})}
				</nav>
				<BrowserIconSizeControl size={iconSize} onSize={setIconSize} />
				<FileSortControl
					sort={display.fileSort}
					direction={display.fileSortDirection}
					onSort={display.setFileSort}
					onDirection={display.setFileSortDirection}
				/>
				<div className="browser-search">
					<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
						<circle cx="7" cy="7" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
						<path d="M10.2 10.2 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
					</svg>
					<input
						ref={searchRef}
						type="search"
						value={query}
						placeholder={t.browser.search(where)}
						aria-label={t.browser.search(where)}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							event.preventDefault();
							if (query) setQuery("");
							else scrollRef.current?.focus();
						}}
					/>
				</div>
			</header>
			<div
				ref={scrollRef}
				className={`browser-scroll thin-scroll${dropHere ? " drop-target" : ""}`}
				tabIndex={0}
				onKeyDown={onKeyDown}
				onPointerDown={onPointerDown}
				onDragOver={(event) => {
					if (location.kind !== "folder") return;
					if (hasOsFileDrag(event.dataTransfer)) {
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
						return;
					}
					if (hasLibraryDrag(event.dataTransfer)) {
						folderDropProps(dropPath, context).onDragOver?.(event);
					}
				}}
				onDragLeave={folderDropProps(dropPath, context).onDragLeave}
				onDrop={(event) => {
					if (location.kind !== "folder") {
						if (hasLibraryDrag(event.dataTransfer)) { event.preventDefault(); endLibraryDrag(); }
						return;
					}
					if (!hasOsFileDrag(event.dataTransfer) && !readLibraryDrag(event.dataTransfer)) return;
					folderDropProps(dropPath, context).onDrop?.(event);
				}}
				onContextMenu={(event) => {
					if (event.target instanceof Element && event.target.closest("[data-key]")) return;
					event.preventDefault();
					if (location.kind === "folder") props.onLibraryContextMenu();
				}}
			>
				<div ref={contentRef} className="browser-content">
					{count === 0 ? (
						<div className="browser-empty">{emptyText}</div>
					) : (
						<div className="browser-grid">
							{listing.folders.map((path) => <FolderTile key={folderKey(path)} relativePath={path} preview={folderPreviews.get(path)} context={context} base={base} searching={searching} />)}
							{listing.assets.map((asset) => <AssetTile key={assetKey(asset.assetId)} asset={asset} context={context} base={base} searching={searching} />)}
						</div>
					)}
					{box ? <div className="browser-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} /> : null}
				</div>
			</div>
			{props.children}
		</section>
	);
}
