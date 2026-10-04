import { useState } from "react";
import type { Asset } from "@loom/core";
import { assetBadgeLabel, assetPreviewUrl } from "./asset-utils.ts";

export type AssetPreview = {
	assetId: string;
	filename: string;
	type: Asset["type"];
	modifiedAt?: number;
};

/** Library-style preview: still for images, a frame for video, a type badge otherwise. */
export function AssetThumbnail({ asset }: { asset: AssetPreview }): React.JSX.Element {
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);

	if (!failed && asset.type === "image") {
		return (
			<span className="asset-thumbnail media-thumbnail">
				<img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
			</span>
		);
	}
	if (!failed && asset.type === "video") {
		return (
			<span className="asset-thumbnail media-thumbnail video-thumbnail">
				<video
					src={url}
					muted
					preload="metadata"
					onLoadedMetadata={(event) => {
						const video = event.currentTarget;
						if (video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
					}}
					onError={() => setFailed(true)}
				/>
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
	const url = assetPreviewUrl(asset);
	if (asset.type === "image") {
		wrap.className = "asset-thumbnail media-thumbnail";
		const img = document.createElement("img");
		img.alt = "";
		img.loading = "lazy";
		img.src = url;
		img.addEventListener("error", () => paintBadge(wrap, asset));
		wrap.append(img);
		return wrap;
	}
	if (asset.type === "video") {
		wrap.className = "asset-thumbnail media-thumbnail video-thumbnail";
		const video = document.createElement("video");
		video.muted = true;
		video.tabIndex = -1;
		video.preload = "metadata";
		video.src = url;
		video.addEventListener("loadedmetadata", () => {
			if (video.duration > 0) video.currentTime = Math.min(0.1, video.duration / 2);
		});
		video.addEventListener("error", () => paintBadge(wrap, asset));
		wrap.append(video);
		return wrap;
	}
	paintBadge(wrap, asset);
	return wrap;
}
