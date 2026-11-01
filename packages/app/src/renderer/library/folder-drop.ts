import { useEffect, useState, type HTMLAttributes } from "react";
import {
	activeLibraryDrag,
	canDropLibraryItem,
	endLibraryDrag,
	hasLibraryDrag,
	hasOsFileDrag,
	readLibraryDrag,
	type LibraryDrag,
} from "../assets/asset-drag.ts";

/** What a folder drop target needs from its surface: the highlight state and the two ways something can land. */
export interface FolderDropSurface {
	dropFolder: string | null;
	onDropFolder: (destFolder: string | null) => void;
	onDropIntoFolder: (destFolder: string, item: LibraryDrag) => void;
	onDropFiles: (destFolder: string, files: File[]) => void;
}

/**
 * Drag handlers that make an element accept library items and files from the OS into `dest`.
 * The element highlights through `surface.dropFolder`. Events stop here, so a folder inside a larger drop area wins.
 */
export function folderDropProps(
	dest: string,
	surface: FolderDropSurface,
): Pick<HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop"> {
	return {
		onDragOver: (event) => {
			if (hasOsFileDrag(event.dataTransfer)) {
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "copy";
				surface.onDropFolder(dest);
				return;
			}
			if (!hasLibraryDrag(event.dataTransfer)) return;
			event.preventDefault();
			event.stopPropagation();
			if (!canDropLibraryItem(dest, activeLibraryDrag())) {
				event.dataTransfer.dropEffect = "none";
				return;
			}
			event.dataTransfer.dropEffect = "move";
			surface.onDropFolder(dest);
		},
		onDragLeave: (event) => {
			const next = event.relatedTarget;
			if (next instanceof Node && event.currentTarget.contains(next)) return;
			surface.onDropFolder(null);
		},
		onDrop: (event) => {
			if (hasOsFileDrag(event.dataTransfer)) {
				event.preventDefault();
				event.stopPropagation();
				surface.onDropFolder(null);
				const files = [...event.dataTransfer.files];
				if (files.length > 0) surface.onDropFiles(dest, files);
				return;
			}
			if (!hasLibraryDrag(event.dataTransfer)) return;
			event.preventDefault();
			event.stopPropagation();
			const item = readLibraryDrag(event.dataTransfer);
			endLibraryDrag();
			surface.onDropFolder(null);
			if (item && canDropLibraryItem(dest, item)) surface.onDropIntoFolder(dest, item);
		},
	};
}

/** The folder highlighted as a drop target. It clears when any drag ends or drops, wherever that happens. */
export function useDropFolder(): [string | null, (destFolder: string | null) => void] {
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
	return [dropFolder, setDropFolder];
}
