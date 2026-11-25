import type { AssetPreview } from "./asset-thumbnail.tsx";
import { assetBadgeLabel, assetPosterUrl, assetPreviewUrl, assetThumbnailUrl } from "./asset-utils.ts";

function paintBadge(host: HTMLElement, asset: AssetPreview): void {
	host.className = `asset-thumbnail asset-badge type-${asset.type}`;
	host.replaceChildren();
	host.textContent = assetBadgeLabel(asset.filename, asset.type);
}

/** The AssetThumbnail presentation for DOM widgets outside React. */
export function createAssetThumbnailElement(asset: AssetPreview, variant: "square" | "poster" = "square"): HTMLSpanElement {
	const wrap = document.createElement("span");
	if (asset.type === "image" || asset.type === "video") {
		wrap.className = `asset-thumbnail media-thumbnail${asset.type === "video" ? " video-thumbnail" : ""}`;
		const img = document.createElement("img");
		img.alt = "";
		img.loading = "lazy";
		img.decoding = "async";
		const thumbnail = variant === "poster" ? assetPosterUrl(asset) : assetThumbnailUrl(asset);
		const sources = [thumbnail, ...(asset.type === "image" ? [assetPreviewUrl(asset)] : [])];
		let next = 0;
		const advance = () => {
			if (next < sources.length) img.src = sources[next++]!;
			else paintBadge(wrap, asset);
		};
		img.addEventListener("error", advance);
		wrap.append(img);
		advance();
		return wrap;
	}
	paintBadge(wrap, asset);
	return wrap;
}
