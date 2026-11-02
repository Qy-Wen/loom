import { useState } from "react";
import type { Asset } from "@loom/core";
import { assetBadgeLabel, assetPreviewUrl, assetThumbnailUrl } from "./asset-utils.ts";

export type AssetPreview = {
	assetId: string;
	filename: string;
	type: Asset["type"];
	modifiedAt?: number;
	size?: number;
};

/**
 * Library-style preview: a cached still for images and video, a type badge otherwise. Both come from the same
 * `loom-asset://thumb` image, so no view decodes an original or runs a `<video>` just to show a thumbnail.
 * An image without a thumbnail (SVG) falls back to its original file; anything that still fails shows the badge.
 */
export function AssetThumbnail({ asset }: { asset: AssetPreview }): React.JSX.Element {
	const [failedUrls, setFailedUrls] = useState<readonly string[]>([]);
	const thumbnail = assetThumbnailUrl(asset);
	const original = assetPreviewUrl(asset);
	const url = [thumbnail, ...(asset.type === "image" ? [original] : [])].find((candidate) => !failedUrls.includes(candidate));

	if (url && (asset.type === "image" || asset.type === "video")) {
		return (
			<span className={`asset-thumbnail media-thumbnail${asset.type === "video" ? " video-thumbnail" : ""}`}>
				<img key={url} src={url} alt="" loading="lazy" decoding="async" onError={() => setFailedUrls((current) => [...current, url])} />
			</span>
		);
	}

	return <span className={`asset-thumbnail asset-badge type-${asset.type}`}>{assetBadgeLabel(asset.filename, asset.type)}</span>;
}

function paintBadge(host: HTMLElement, asset: AssetPreview): void {
	host.className = `asset-thumbnail asset-badge type-${asset.type}`;
	host.replaceChildren();
	host.textContent = assetBadgeLabel(asset.filename, asset.type);
}

/** Same preview as AssetThumbnail, for chips painted into a contenteditable. */
export function createAssetThumbnailElement(asset: AssetPreview): HTMLSpanElement {
	const wrap = document.createElement("span");
	if (asset.type === "image" || asset.type === "video") {
		wrap.className = `asset-thumbnail media-thumbnail${asset.type === "video" ? " video-thumbnail" : ""}`;
		const img = document.createElement("img");
		img.alt = "";
		img.loading = "lazy";
		img.decoding = "async";
		const sources = [assetThumbnailUrl(asset), ...(asset.type === "image" ? [assetPreviewUrl(asset)] : [])];
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
