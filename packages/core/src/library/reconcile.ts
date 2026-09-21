import { randomUUID } from "node:crypto";
import { assetTypeFromPath, type Asset } from "../model/asset.ts";

export interface ReconcileDiskFile {
	relativePath: string;
	filename: string;
	fileSystemId: string | null;
	size: number;
	createdAt: number;
	modifiedAt: number;
}

/** Full-library match used on open. Does not mutate the store. */
export function reconcileOpenAssets(
	existing: Asset[],
	diskFiles: ReconcileDiskFile[],
	trustPath: boolean,
): Asset[] {
	if (trustPath) return matchByPath(existing, diskFiles);

	const next: Asset[] = [];
	const usedPaths = new Set<string>();
	const usedAssetIds = new Set<string>();
	const byFileSystemId = new Map<string, Asset>();
	for (const asset of existing) {
		if (asset.fileSystemId) byFileSystemId.set(asset.fileSystemId, asset);
	}
	const byPath = new Map(existing.map((asset) => [asset.relativePath, asset]));

	for (const file of diskFiles) {
		if (!file.fileSystemId) continue;
		const asset = byFileSystemId.get(file.fileSystemId);
		if (!asset || usedAssetIds.has(asset.assetId)) continue;
		next.push(assetFromDisk(asset.assetId, file));
		usedPaths.add(file.relativePath);
		usedAssetIds.add(asset.assetId);
	}

	for (const file of diskFiles) {
		if (usedPaths.has(file.relativePath)) continue;
		const asset = byPath.get(file.relativePath);
		if (!asset || usedAssetIds.has(asset.assetId)) continue;
		if (asset.fileSystemId && file.fileSystemId && asset.fileSystemId !== file.fileSystemId) continue;
		next.push(assetFromDisk(asset.assetId, file));
		usedPaths.add(file.relativePath);
		usedAssetIds.add(asset.assetId);
	}

	for (const file of diskFiles) {
		if (usedPaths.has(file.relativePath)) continue;
		next.push(assetFromDisk(randomUUID(), file));
	}

	return next;
}

function matchByPath(existing: Asset[], diskFiles: ReconcileDiskFile[]): Asset[] {
	const byPath = new Map(existing.map((asset) => [asset.relativePath, asset]));
	return diskFiles.map((file) => {
		const asset = byPath.get(file.relativePath);
		return assetFromDisk(asset?.assetId ?? randomUUID(), file);
	});
}

function assetFromDisk(assetId: string, file: ReconcileDiskFile): Asset {
	return {
		assetId,
		relativePath: file.relativePath,
		filename: file.filename,
		type: assetTypeFromPath(file.relativePath),
		size: file.size,
		createdAt: file.createdAt,
		modifiedAt: file.modifiedAt,
		fileSystemId: file.fileSystemId,
	};
}
