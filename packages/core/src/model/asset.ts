import { extname } from "node:path";
import type { AssetTag, Tag } from "./tag.ts";

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
	/** Favorite asset ids, newest first. */
	favoriteAssetIds: string[];
	/** Tags in the open library, sorted by name. */
	tags: Tag[];
	/** Tag links, oldest first. */
	assetTags: AssetTag[];
}

export type LibraryChange =
	| { type: "reset"; snapshot: LibrarySnapshot }
	| { type: "upsert"; asset: Asset }
	| { type: "remove"; assetId: string }
	| { type: "folder_upsert"; relativePath: string }
	| { type: "folder_remove"; relativePath: string }
	| { type: "favorites"; assetIds: string[] }
	| { type: "tags"; tags: Tag[]; assetTags: AssetTag[] }
	| { type: "error"; message: string }
	| { type: "enrichment"; assetId: string }
	| { type: "text_embed"; assetId: string }
	| { type: "image_vlm"; assetId: string }
	| { type: "video_vlm"; assetId: string }
	| { type: "audio_writeup"; assetId: string };

const EXTENSIONS: Record<Exclude<AssetType, "other">, ReadonlySet<string>> = {
	image: new Set([".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]),
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
