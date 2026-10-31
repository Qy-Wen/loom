import { useRef } from "react";
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
import { useLocale } from "../locale.tsx";
import { AssetList } from "./asset-rows.tsx";
import { clickMode, useScrollWhenFocused, useTree } from "./tree-context.tsx";
import { compareAssetPaths, compareFolderPaths, coversPath, folderKey } from "./tree-nav.ts";
import { useInlineRename } from "./use-inline-rename.ts";

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
	const selected = tree.selectedKeys.has(key);
	const renaming = folder.relativePath === tree.renamingFolder;
	const cut = coversPath(tree.cutFolders, folder.relativePath);
	const rowRef = useRef<HTMLDivElement | null>(null);
	useScrollWhenFocused(rowRef, tree.focusKey === key, key);
	const renameInput = useInlineRename(
		folder.name,
		renaming,
		(name) => tree.onRenameFolder(folder.relativePath, name),
		tree.onCancelRename,
	);

	function chooseFolder(event: React.MouseEvent): void {
		const mode = clickMode(event);
		tree.onSelectFolder(folder.relativePath, mode);
		if (mode === "replace") tree.onToggleFolder(folder.relativePath);
	}

	return (
		<div
			onDragOver={(event) => {
				if (hasOsFileDrag(event.dataTransfer)) {
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "copy";
					tree.onDropFolder(folder.relativePath);
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
				tree.onDropFolder(folder.relativePath);
			}}
			onDragLeave={(event) => {
				const next = event.relatedTarget;
				if (next instanceof Node && event.currentTarget.contains(next)) return;
				tree.onDropFolder(null);
			}}
			onDrop={(event) => {
				if (hasOsFileDrag(event.dataTransfer)) {
					event.preventDefault();
					event.stopPropagation();
					tree.onDropFolder(null);
					const files = [...event.dataTransfer.files];
					if (files.length > 0) tree.onDropFiles(folder.relativePath, files);
					return;
				}
				if (!hasLibraryDrag(event.dataTransfer)) return;
				event.preventDefault();
				event.stopPropagation();
				const item = readLibraryDrag(event.dataTransfer);
				endLibraryDrag();
				tree.onDropFolder(null);
				if (item && canDropLibraryItem(folder.relativePath, item)) {
					tree.onDropIntoFolder(folder.relativePath, item);
				}
			}}
		>
			<div
				ref={rowRef}
				className={`folder-row ${selected ? "selected" : ""}${cut ? " cut" : ""}${tree.dropFolder === folder.relativePath ? " drop-target" : ""}`}
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
						<input {...renameInput} />
					</div>
				) : (
					<button
						className="folder-main"
						type="button"
						draggable
						onDragStart={(event) => {
							const single: LibraryDrag = { kind: "folder", relativePath: folder.relativePath };
							writeLibraryDrag(event.dataTransfer, selected && tree.selectionDrag ? tree.selectionDrag : single);
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
						<span className="folder-symbol" aria-hidden="true">
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
								<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2c.5 0 .9.2 1.2.6l.9 1.2c.3.4.7.6 1.2.6H19.5A1.5 1.5 0 0 1 21 9.9v7.6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z" />
							</svg>
						</span>
						<span className="asset-name">{folder.name}</span>
					</button>
				)}
			</div>
			{!collapsed && <FileTreeRows node={folder} depth={depth + 1} />}
		</div>
	);
}

function FileTreeRows({ node, depth }: { node: FolderNode; depth: number }): React.JSX.Element {
	const { fileSort, fileSortDirection, folderModifiedAt } = useTree();
	const folders = [...node.folders.values()].sort((a, b) => (
		compareFolderPaths(a.relativePath, b.relativePath, fileSort, folderModifiedAt, fileSortDirection)
	));
	const assets = [...node.assets].sort((a, b) => compareAssetPaths(a, b, fileSort, fileSortDirection));

	return (
		<>
			{folders.map((folder) => <FolderTreeRow key={folder.relativePath} folder={folder} depth={depth} />)}
			<AssetList assets={assets} depth={depth} />
		</>
	);
}

/** The folder tree of `library`. Needs a `TreeProvider` above it. */
export function FileTree({ library }: { library: LibrarySnapshot }): React.JSX.Element {
	return <FileTreeRows node={buildFileTree(library)} depth={0} />;
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
