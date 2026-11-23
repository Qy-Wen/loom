import { randomUUID } from "node:crypto";
import { clipboard } from "electron";
import { decodeFileNameW, dropEffectIsMove } from "../../shared/file-clipboard.ts";
import { readMacFilePaths, writeMacFilePaths } from "./mac-file-clipboard.ts";
import { readWindowsFilePaths, writeWindowsFilePaths } from "./windows-file-clipboard.ts";

const libraryClipboardFormat = "com.loom.library-items";
let libraryClipboard: { token: string; assetIds: string[]; folders: string[]; move: boolean } | null = null;

export async function writeLibraryClipboard(assetIds: string[], folders: string[], move: boolean, paths: string[]): Promise<string> {
	const token = randomUUID();
	// Keep Loom's cut internal. Copies carry native file references alongside the token.
	if (move || (process.platform !== "darwin" && process.platform !== "win32")) {
		clipboard.writeBuffer(libraryClipboardFormat, Buffer.from(token));
	} else if (process.platform === "darwin") {
		await writeMacFilePaths(paths, libraryClipboardFormat, token);
	} else {
		await writeWindowsFilePaths(paths, libraryClipboardFormat, token);
	}
	libraryClipboard = { token, assetIds, folders, move };
	return token;
}

export function readLibraryClipboard(): typeof libraryClipboard {
	if (!libraryClipboard) return null;
	try {
		const { token } = libraryClipboard;
		const stored = clipboard.readBuffer(libraryClipboardFormat);
		// Windows can pad a custom clipboard format to its allocation size.
		return stored.subarray(0, token.length).toString() === token ? libraryClipboard : null;
	} catch {
		return null;
	}
}

export function clearLibraryClipboard(token?: string): void {
	if (token === undefined || libraryClipboard?.token === token) libraryClipboard = null;
}

export interface FileClipboard {
	paths: string[];
	move: boolean;
}

/**
 * Read file lists through each platform's native clipboard API.
 * Windows: `FileNameW` is only the first path, so PowerShell reads the full drop list.
 * macOS: file URLs are readable. Finder's cut flag is private, so a paste from Finder copies.
 */
export async function readFileClipboard(): Promise<FileClipboard | null> {
	if (process.platform === "win32") return readWindowsFileClipboard();
	if (process.platform === "darwin") {
		const paths = await readMacFilePaths();
		return paths.length > 0 ? { paths, move: false } : null;
	}
	return null;
}

export async function clipboardHasFiles(): Promise<boolean> {
	if (readLibraryClipboard()) return true;
	if (process.platform === "win32") {
		try {
			return clipboard.availableFormats().includes("text/uri-list")
				|| decodeFileNameW(clipboard.readBuffer("FileNameW")).trim().length > 0;
		} catch {
			return false;
		}
	}
	if (process.platform === "darwin") {
		return (await readMacFilePaths()).length > 0;
	}
	return false;
}

async function readWindowsFileClipboard(): Promise<FileClipboard | null> {
	let move = false;
	try {
		move = dropEffectIsMove(clipboard.readBuffer("Preferred DropEffect"));
	} catch {
		move = false;
	}

	let paths: string[] = [];
	try {
		paths = await readWindowsFilePaths();
	} catch {
		paths = [];
	}
	if (paths.length === 0) {
		try {
			const single = decodeFileNameW(clipboard.readBuffer("FileNameW")).trim();
			if (single) paths = [single];
		} catch {
			paths = [];
		}
	}
	return paths.length > 0 ? { paths, move } : null;
}
