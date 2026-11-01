import { useStoredState } from "./use-stored-state.ts";
import type { FileDisplay, FileSort, FileSortDirection } from "./tree-nav.ts";

export interface LibraryDisplay {
	fileDisplay: FileDisplay;
	setFileDisplay: (value: FileDisplay) => void;
	fileSort: FileSort;
	setFileSort: (value: FileSort) => void;
	fileSortDirection: FileSortDirection;
	setFileSortDirection: (value: FileSortDirection) => void;
}

/** How the library files are shown and ordered. Kept in one place because the sidebar and the folder browser both read it. */
export function useLibraryDisplay(): LibraryDisplay {
	const [fileDisplay, setFileDisplay] = useStoredState<FileDisplay>("loom.library.fileDisplay", ["list", "icons"], "list");
	const [fileSort, setFileSort] = useStoredState<FileSort>("loom.library.fileSort", ["name", "modified"], "name");
	const [fileSortDirection, setFileSortDirection] = useStoredState<FileSortDirection>(
		"loom.library.fileSortDirection",
		["asc", "desc"],
		fileSort === "modified" ? "desc" : "asc",
	);
	return { fileDisplay, setFileDisplay, fileSort, setFileSort, fileSortDirection, setFileSortDirection };
}
