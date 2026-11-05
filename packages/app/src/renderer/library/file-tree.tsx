import { useRef } from "react";
import type { Asset, LibrarySnapshot } from "@loom/core";
import { endLibraryDrag, writeLibraryDrag, type LibraryDrag } from "../assets/asset-drag.ts";
import { useLocale } from "../locale.tsx";
import { AssetList } from "./asset-rows.tsx";
import { folderDropProps } from "./folder-drop.ts";
import { clickMode, useScrollWhenFocused, useTree } from "./tree-context.tsx";
import { compareAssetPaths, compareFolderPaths, coversPath, folderKey } from "./tree-nav.ts";
import { useInlineRename } from "./use-inline-rename.ts";
import { useFolderDoubleClick } from "./use-folder-double-click.ts";

interface FolderNode {
	name: string;
	relativePath: string;
	folders: Map<string, FolderNode>;
	assets: Asset[];
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

function FolderTreeRow({ folder, depth }: { folder: FolderNode; depth: number }): React.JSX.Element {
	const { t } = useLocale();
	const tree = useTree();
	const key = folderKey(folder.relativePath);
	const collapsed = tree.collapsedFolders.has(folder.relativePath);
	// A folder shows its arrow only when opening it reveals something: subfolders, plus files in the list view.
	const expandable = folder.folders.size > 0 || (!tree.foldersOnly && folder.assets.length > 0);
	// The folders tree highlights the picked folders, or the folder the browser is showing when none is picked.
	const picking = !tree.foldersOnly || tree.selectedKeys.size > 0;
	const selected = picking ? tree.selectedKeys.has(key) : tree.currentFolder === folder.relativePath;
	const renaming = folder.relativePath === tree.renamingFolder;
	const cut = coversPath(tree.cutFolders, folder.relativePath);
	const rowRef = useRef<HTMLDivElement | null>(null);
	const isDoubleClick = useFolderDoubleClick();
	useScrollWhenFocused(rowRef, picking ? tree.focusKey === key : selected, key);
	const renameInput = useInlineRename(
		folder.name,
		renaming,
		(name) => tree.onRenameFolder(folder.relativePath, name),
		tree.onCancelRename,
	);

	function chooseFolder(event: React.MouseEvent): void {
		if (tree.foldersOnly) {
			// A modifier click edits the selection and leaves the browser where it is.
			const double = isDoubleClick(event);
			const mode = clickMode(event);
			tree.onSelectFolder(folder.relativePath, mode);
			if (mode !== "replace") {
				return;
			}
			// A click opens the folder in the browser; a second one soon after folds it. The clicks are timed here
			// instead of using `dblclick`, which fires once per run of clicks and so ignores a quick second double click.
			if (double) tree.onToggleFolder(folder.relativePath);
			return;
		}
		const mode = clickMode(event);
		tree.onSelectFolder(folder.relativePath, mode);
		if (mode === "replace") tree.onToggleFolder(folder.relativePath);
	}

	return (
		<div {...folderDropProps(folder.relativePath, tree)}>
			<div
				ref={rowRef}
				className={`folder-row ${selected ? "selected" : ""}${cut ? " cut" : ""}${tree.dropFolder === folder.relativePath ? " drop-target" : ""}`}
				style={{ paddingLeft: 7 + depth * 14 }}
			>
				{expandable ? (
					<button
						className={`folder-chevron${collapsed ? "" : " expanded"}`}
						type="button"
						aria-label={collapsed ? t.library.expandFolder : t.library.collapseFolder}
						onClick={tree.foldersOnly ? () => tree.onToggleFolder(folder.relativePath) : chooseFolder}
					>
						<FolderChevronIcon />
					</button>
				) : <span className="folder-chevron-spacer" aria-hidden="true" />}
				{renaming ? (
					<div className="rename-editor">
						<input {...renameInput} />
					</div>
				) : (
					<button
						className="folder-main"
						type="button"
						draggable
						onDragStart={(event) => {
							const single: LibraryDrag = { kind: "folder", relativePath: folder.relativePath };
							writeLibraryDrag(event.dataTransfer, selected && picking && tree.selectionDrag ? tree.selectionDrag : single);
						}}
						onDragEnd={() => {
							endLibraryDrag();
							tree.onDropFolder(null);
						}}
						onClick={chooseFolder}
						onContextMenu={(event) => {
							event.preventDefault();
							tree.onFolderContextMenu(folder.relativePath);
						}}
					>
						<span className="folder-symbol" aria-hidden="true"><FolderIcon /></span>
						<span className="asset-name">{folder.name}</span>
					</button>
				)}
			</div>
			{!collapsed && <FileTreeRows node={folder} depth={depth + 1} />}
		</div>
	);
}

function FileTreeRows({ node, depth }: { node: FolderNode; depth: number }): React.JSX.Element {
	const { fileSort, fileSortDirection, folderModifiedAt, foldersOnly } = useTree();
	const folders = [...node.folders.values()].sort((a, b) => (
		compareFolderPaths(a.relativePath, b.relativePath, fileSort, folderModifiedAt, fileSortDirection)
	));
	const assets = [...node.assets].sort((a, b) => compareAssetPaths(a, b, fileSort, fileSortDirection));

	return (
		<>
			{folders.map((folder) => <FolderTreeRow key={folder.relativePath} folder={folder} depth={depth} />)}
			{foldersOnly ? null : <AssetList assets={assets} depth={depth} />}
		</>
	);
}

/** The icon-mode tree heading opens the root folder and accepts drops into it. */
export function LibraryRootButton({ name, title, onOpen }: { name: string; title: string | undefined; onOpen: () => void }): React.JSX.Element {
	const tree = useTree();
	return (
		<button
			{...folderDropProps("", tree)}
			className={`library-files-name library-root-button${tree.dropFolder === "" ? " drop-target" : ""}`}
			type="button"
			data-tooltip={title}
			aria-current={tree.currentFolder === "" ? "location" : undefined}
			onClick={onOpen}
		>
			{name}
		</button>
	);
}

/** The folder tree of `library`. Needs a `TreeProvider` above it. */
export function FileTree({ library }: { library: LibrarySnapshot }): React.JSX.Element {
	return <FileTreeRows node={buildFileTree(library)} depth={0} />;
}

export function FolderIcon({ size = 16 }: { size?: number }): React.JSX.Element {
	return (
		<svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2c.5 0 .9.2 1.2.6l.9 1.2c.3.4.7.6 1.2.6H19.5A1.5 1.5 0 0 1 21 9.9v7.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
		</svg>
	);
}

export function FolderChevronIcon(): React.JSX.Element {
	return (
		// The viewBox is cropped to the stroke, so the arrow carries no blank margin of its own.
		<svg viewBox="6 0 4 16" width="4" height="16" aria-hidden="true">
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
