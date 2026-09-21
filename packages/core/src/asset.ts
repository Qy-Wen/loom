import { extname } from "node:path";

export type AssetType = "image" | "video" | "audio" | "text" | "other";

export interface Asset {
	assetId: string;
	/** POSIX-style path relative to the library root. */
	relativePath: string;
	filename: string;
	type: AssetType;
	size: number;
	createdAt: number;
	modifiedAt: number;
	/**
	 * `file_system_id`: identity assigned by the OS filesystem, not Loom.
	 * Node `stat` `(dev, ino)` — inode on macOS/Linux, volume + file index on Windows.
	 * Stable across rename/move on the same volume; null if the FS has no usable id.
	 */
	fileSystemId?: string | null;
}

export interface LibrarySnapshot {
	rootPath: string | null;
	/** POSIX-style paths relative to the library root. */
	folders: string[];
	assets: Asset[];
}

export type LibraryChange =
	| { type: "reset"; snapshot: LibrarySnapshot }
	| { type: "upsert"; asset: Asset }
	| { type: "remove"; assetId: string }
	| { type: "folder_upsert"; relativePath: string }
	| { type: "folder_remove"; relativePath: string }
	| { type: "error"; message: string };

const EXTENSIONS: Record<Exclude<AssetType, "other">, ReadonlySet<string>> = {
	image: new Set([".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".webp"]),
	video: new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]),
	audio: new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]),
	text: new Set([".csv", ".html", ".json", ".md", ".pdf", ".txt"]),
};

export function assetTypeFromPath(path: string): AssetType {
	const extension = extname(path).toLowerCase();
	for (const [type, extensions] of Object.entries(EXTENSIONS)) {
		if (extensions.has(extension)) return type as AssetType;
	}
	return "other";
}
