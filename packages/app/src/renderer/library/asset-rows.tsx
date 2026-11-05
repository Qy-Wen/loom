import { useRef } from "react";
import type { Asset } from "@loom/core";
import { endLibraryDrag, writeLibraryDrag, type LibraryDrag } from "../assets/asset-drag.ts";
import { AssetThumbnail } from "../assets/asset-thumbnail.tsx";
import { extensionOf, filenameStem } from "../assets/asset-utils.ts";
import { useLocale } from "../locale.tsx";
import { assetKey, coversPath } from "./tree-nav.ts";
import { clickMode, useScrollWhenFocused, useTree, type TreeContextValue } from "./tree-context.tsx";
import { useInlineRename } from "./use-inline-rename.ts";

/**
 * Middle-click opens the file in a new tab, like a browser link. Double-click cannot: its first click already
 * replaced the active tab with this file, so the second has nothing left to open.
 */
export function openInTabHandlers(open: () => void): Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, "onMouseDown" | "onAuxClick"> {
	return {
		// Windows starts autoscroll on a middle press; keep it from stealing the click.
		onMouseDown: (event) => {
			if (event.button === 1) event.preventDefault();
		},
		onAuxClick: (event) => {
			if (event.button === 1) open();
		},
	};
}

/**
 * Files as list rows.
 * `quiet` is for shortcut lists: their rows never take the tree's focus or host a rename editor, because the same
 * file also appears in the tree.
 */
export function AssetList({ assets, depth, quiet = false }: { assets: readonly Asset[]; depth: number; quiet?: boolean }): React.JSX.Element | null {
	if (assets.length === 0) return null;
	return <>{assets.map((asset) => <AssetTreeRow key={asset.assetId} asset={asset} depth={depth} quiet={quiet} />)}</>;
}

function useAssetRow(asset: Asset, quiet: boolean) {
	const tree = useTree();
	const selected = tree.selectedKeys.has(assetKey(asset.assetId));
	return {
		tree,
		selected,
		focused: !quiet && tree.focusKey === assetKey(asset.assetId),
		renaming: !quiet && tree.renamingAssetId === asset.assetId,
		cut: tree.cutAssetIds.includes(asset.assetId) || coversPath(tree.cutFolders, asset.relativePath),
		favorite: tree.favoriteAssetIds.has(asset.assetId),
	};
}

/** Drag, click, middle-click, and context-menu handlers of a list row. */
function assetButtonProps(tree: TreeContextValue, asset: Asset, selected: boolean): React.ButtonHTMLAttributes<HTMLButtonElement> {
	return {
		onDragStart: (event) => {
			const single: LibraryDrag = { kind: "asset", assetId: asset.assetId, path: asset.relativePath };
			writeLibraryDrag(event.dataTransfer, selected && tree.selectionDrag ? tree.selectionDrag : single, asset);
		},
		onDragEnd: () => {
			endLibraryDrag();
			tree.onDropFolder(null);
		},
		...openInTabHandlers(() => tree.onOpenAssetInTab(asset.assetId)),
		onClick: (event) => tree.onSelectAsset(asset.assetId, clickMode(event)),
		onContextMenu: (event) => {
			event.preventDefault();
			tree.onAssetContextMenu(asset);
		},
	};
}

function AssetTreeRow({ asset, depth, quiet }: { asset: Asset; depth: number; quiet: boolean }): React.JSX.Element {
	const { tree, selected, focused, renaming, cut, favorite } = useAssetRow(asset, quiet);
	const rowRef = useRef<HTMLElement | null>(null);
	useScrollWhenFocused(rowRef, focused, asset.assetId);
	const renameInput = useInlineRename(filenameStem(asset.filename), renaming, (stem) => tree.onRenameAsset(asset, stem), tree.onCancelRename);

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
					<input {...renameInput} />
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
			{...assetButtonProps(tree, asset, selected)}
		>
			<AssetThumbnail asset={asset} />
			<span className="asset-name" data-tooltip={asset.relativePath}>{asset.filename}</span>
			{favorite ? <FavoriteMark /> : null}
		</button>
	);
}

export function FavoriteMark(): React.JSX.Element {
	const { t } = useLocale();
	return (
		<span className="asset-favorite" data-tooltip={t.common.favorite}>
			<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
				<path fill="currentColor" d="M8 1.6 9.9 5.7l4.5.4-3.4 2.9.1 4.5L8 11.6 4.9 13.5l.1-4.5L1.6 6.1l4.5-.4L8 1.6z" />
			</svg>
		</span>
	);
}
