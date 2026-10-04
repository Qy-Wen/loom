import type { Asset } from "@loom/core";

/** Drag payload for sticking a library file onto the composer. Keyed by asset id; path stays relative. */
export const LOOM_ASSET_DRAG = "application/x-loom-asset";

export function writeAssetDrag(transfer: DataTransfer, asset: Asset): void {
	transfer.effectAllowed = "copy";
	transfer.setData(LOOM_ASSET_DRAG, JSON.stringify({
		assetId: asset.assetId,
		path: asset.relativePath,
		assetType: asset.type,
	}));
}

export function readAssetDrag(transfer: DataTransfer): unknown {
	const raw = transfer.getData(LOOM_ASSET_DRAG);
	if (!raw) return undefined;
	return JSON.parse(raw) as unknown;
}
