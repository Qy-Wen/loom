import type { Asset } from "@loom/core";

export function sortAssets(assets: Asset[]): Asset[] {
	return [...assets].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
	if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
}

export function extensionOf(filename: string): string {
	const dot = filename.lastIndexOf(".");
	return dot < 0 ? "" : filename.slice(dot).toLowerCase();
}

export function filenameStem(filename: string): string {
	const extension = extensionOf(filename);
	return extension ? filename.slice(0, -extension.length) : filename;
}

export function assetPreviewUrl(asset: { assetId: string; modifiedAt?: number; size?: number }): string {
	const id = encodeURIComponent(asset.assetId);
	if (asset.modifiedAt == null) return `loom-asset://asset/${id}`;
	// Size changes when a file is still being written, so a just-saved video does not keep the first empty response.
	const version = asset.size ? `${asset.modifiedAt}-${asset.size}` : String(asset.modifiedAt);
	return `loom-asset://asset/${id}?v=${version}`;
}

/** Same badge letters the library tree uses for audio / text / other. */
export function assetBadgeLabel(filename: string, type: Asset["type"]): string {
	if (type === "audio") return "♪";
	return extensionOf(filename).slice(1, 4).toUpperCase() || type[0].toUpperCase();
}
