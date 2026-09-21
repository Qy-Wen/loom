import { stat } from "node:fs/promises";

/**
 * Portable filesystem identity from Node `fs.stat`.
 * macOS/Linux: device + inode. Windows: volume serial + 64-bit file index.
 * `fileSystemId` is null when the filesystem does not expose a usable id (e.g. FAT).
 */
export interface AssetFileInfo {
	fileSystemId: string | null;
	size: number;
	createdAt: number;
	modifiedAt: number;
	isFile: boolean;
}

export function fileSystemIdFromDevIno(dev: bigint, ino: bigint): string | null {
	if (ino === 0n) return null;
	return `${dev.toString()}:${ino.toString()}`;
}

export async function statAssetFile(absolutePath: string): Promise<AssetFileInfo> {
	const info = await stat(absolutePath, { bigint: true });
	const created = info.birthtimeMs === 0n ? info.ctimeMs : info.birthtimeMs;
	return {
		fileSystemId: info.isFile() ? fileSystemIdFromDevIno(info.dev, info.ino) : null,
		size: Number(info.size),
		createdAt: Number(created),
		modifiedAt: Number(info.mtimeMs),
		isFile: info.isFile(),
	};
}
