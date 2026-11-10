import { useEffect, useState } from "react";
import type { Asset, Tag } from "@loom/core";
import { endLibraryDrag, writeLibraryDrag, type LibraryDrag } from "../../assets/asset-drag.ts";
import { BrowserAssetThumbnail } from "./browser-asset-thumbnail.tsx";
import { extensionOf, filenameStem } from "../../assets/asset-utils.ts";
import { BrowserFolderThumbnail } from "./browser-folder-thumbnail.tsx";
import type { BrowserFolderPreview } from "./browser-folder-preview.ts";
import { FavoriteMark } from "../../library/asset-rows.tsx";
import { folderDropProps, type FolderDropSurface } from "../../library/folder-drop.ts";
import { clickMode } from "../../library/tree-context.tsx";
import { assetKey, folderKey, type PointerMode } from "../../library/tree-nav.ts";
import { useInlineRename } from "../../library/use-inline-rename.ts";
import { TagHashIcon } from "../../components/tag-icon.tsx";

/** What a tile needs from the browser around it. */
export interface TileContext extends FolderDropSurface {
	selectedKeys: ReadonlySet<string>;
	cutAssetIds: readonly string[];
	cutFolders: readonly string[];
	favoriteAssetIds: ReadonlySet<string>;
	selectionDrag: LibraryDrag | null;
	renamingAssetId: string | null;
	renamingFolder: string | null;
	onSelect: (key: string, mode: PointerMode) => void;
	onOpenAsset: (assetId: string) => void;
	onOpenFolder: (relativePath: string) => void;
	onAssetContextMenu: (asset: Asset) => void;
	onFolderContextMenu: (relativePath: string) => void;
	onRenameAsset: (asset: Asset, stem: string) => Promise<void>;
	onRenameFolder: (relativePath: string, name: string) => Promise<void>;
	onCancelRename: () => void;
}

function pathHint(relativePath: string, base: string): string | null {
	const inside = base ? relativePath.slice(base.length + 1) : relativePath;
	const slash = inside.lastIndexOf("/");
	return slash === -1 ? null : inside.slice(0, slash);
}

export function AssetTile({ asset, context, base, searching }: { asset: Asset; context: TileContext; base: string; searching: boolean }): React.JSX.Element {
	const key = assetKey(asset.assetId);
	const selected = context.selectedKeys.has(key);
	const renaming = context.renamingAssetId === asset.assetId;
	const [hovered, setHovered] = useState(false);
	useEffect(() => { if (renaming) setHovered(false); }, [renaming]);
	const cut = context.cutAssetIds.includes(asset.assetId) || context.cutFolders.some((folder) => asset.relativePath.startsWith(`${folder}/`));
	const hint = searching ? pathHint(asset.relativePath, base) : null;
	const rename = useInlineRename(filenameStem(asset.filename), renaming, (stem) => context.onRenameAsset(asset, stem), context.onCancelRename);
	const className = `browser-tile${selected ? " selected" : ""}${cut ? " cut" : ""}`;
	const thumb = (
		<span className="browser-tile-thumb">
			<BrowserAssetThumbnail asset={asset} active={hovered && !renaming} />
			{context.favoriteAssetIds.has(asset.assetId) ? <FavoriteMark /> : null}
		</span>
	);
	if (renaming) {
		return (
			<div className={className} data-key={key}>
				{thumb}
				<span className="browser-tile-rename">
					<input {...rename} />
					<span>{extensionOf(asset.filename)}</span>
				</span>
			</div>
		);
	}
	return (
		<button
			type="button"
			className={className}
			data-key={key}
			draggable
			data-tooltip={asset.relativePath}
			onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(true); }}
			onPointerLeave={() => setHovered(false)}
			onPointerCancel={() => setHovered(false)}
			onClick={(event) => context.onSelect(key, clickMode(event))}
			onDoubleClick={() => context.onOpenAsset(asset.assetId)}
			onContextMenu={(event) => {
				event.preventDefault();
				setHovered(false);
				context.onAssetContextMenu(asset);
			}}
			onDragStart={(event) => {
				setHovered(false);
				const single: LibraryDrag = { kind: "asset", assetId: asset.assetId, path: asset.relativePath };
				writeLibraryDrag(event.dataTransfer, selected && context.selectionDrag ? context.selectionDrag : single, asset);
			}}
			onDragEnd={() => {
				endLibraryDrag();
				context.onDropFolder(null);
			}}
		>
			{thumb}
			<span className="browser-tile-name">{asset.filename}</span>
			{hint ? <span className="browser-tile-hint">{hint}</span> : null}
		</button>
	);
}

/** A tag is a virtual folder; its selection never enters filesystem commands or drag payloads. */
export function TagTile({ tag, selected, onSelect, onOpen }: { tag: Tag; selected: boolean; onSelect: () => void; onOpen: () => void }): React.JSX.Element {
	return (
		<button
			type="button"
			className={`browser-tile folder tag${selected ? " selected" : ""}`}
			data-key={`tag:${tag.tagId}`}
			data-tooltip={tag.name}
			onFocus={onSelect}
			onClick={onSelect}
			onDoubleClick={onOpen}
		>
			<span className="browser-tile-thumb">
				<BrowserFolderThumbnail />
				<TagHashIcon className="browser-tag-mark" />
			</span>
			<span className="browser-tile-name">{tag.name}</span>
		</button>
	);
}

export function FolderTile({ relativePath, preview, context, base, searching }: { relativePath: string; preview?: BrowserFolderPreview; context: TileContext; base: string; searching: boolean }): React.JSX.Element {
	const key = folderKey(relativePath);
	const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
	const selected = context.selectedKeys.has(key);
	const renaming = context.renamingFolder === relativePath;
	const cut = context.cutFolders.some((folder) => relativePath === folder || relativePath.startsWith(`${folder}/`));
	const hint = searching ? pathHint(relativePath, base) : null;
	const rename = useInlineRename(name, renaming, (next) => context.onRenameFolder(relativePath, next), context.onCancelRename);
	const className = `browser-tile folder${selected ? " selected" : ""}${cut ? " cut" : ""}${context.dropFolder === relativePath ? " drop-target" : ""}`;
	const thumb = <span className="browser-tile-thumb"><BrowserFolderThumbnail preview={preview} /></span>;
	if (renaming) {
		return (
			<div className={className} data-key={key}>
				{thumb}
				<span className="browser-tile-rename"><input {...rename} /></span>
			</div>
		);
	}
	return (
		<button
			type="button"
			className={className}
			data-key={key}
			draggable
			data-tooltip={relativePath}
			onClick={(event) => context.onSelect(key, clickMode(event))}
			onDoubleClick={() => context.onOpenFolder(relativePath)}
			onContextMenu={(event) => {
				event.preventDefault();
				context.onFolderContextMenu(relativePath);
			}}
			onDragStart={(event) => {
				const single: LibraryDrag = { kind: "folder", relativePath };
				writeLibraryDrag(event.dataTransfer, selected && context.selectionDrag ? context.selectionDrag : single);
			}}
			onDragEnd={() => {
				endLibraryDrag();
				context.onDropFolder(null);
			}}
			{...folderDropProps(relativePath, context)}
		>
			{thumb}
			<span className="browser-tile-name">{name}</span>
			{hint ? <span className="browser-tile-hint">{hint}</span> : null}
		</button>
	);
}
