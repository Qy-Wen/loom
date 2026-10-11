import { useState } from "react";
import type { Asset } from "@loom/core";
import { assetBadgeLabel, assetPreviewUrl } from "./asset-utils.ts";

export type AssetPreview = {
	assetId: string;
	filename: string;
	type: Asset["type"];
	modifiedAt?: number;
	size?: number;
};

/** Ask Chromium for a poster frame. A seek inside loadedmetadata is dropped for a file it has never decoded. */
function videoFrameUrl(url: string): string {
	return `${url}#t=0.1`;
}

function revealVideoFrame(video: HTMLVideoElement): void {
	if (video.dataset.poster === "1") return;
	video.dataset.poster = "1";
	const seek = (nudge: boolean) => {
		if (!video.isConnected || !(video.duration > 0)) return;
		const base = Math.min(0.1, video.duration / 2);
		const target = nudge ? Math.min(video.duration, base + 0.05) : base;
		if (!nudge && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - base) < 0.03) return;
		video.currentTime = target;
	};
	window.setTimeout(() => seek(false), 0);
	video.addEventListener("seeked", () => {
		if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
		window.setTimeout(() => seek(true), 100);
	}, { once: true });
}

/** Library-style preview: still for images, a frame for video, a type badge otherwise. */
export function AssetThumbnail({ asset }: { asset: AssetPreview }): React.JSX.Element {
	const [failedUrl, setFailedUrl] = useState<string | null>(null);
	const url = assetPreviewUrl(asset);
	const failed = failedUrl === url;

	if (!failed && asset.type === "image") {
		return (
			<span className="asset-thumbnail media-thumbnail">
				<img src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)} />
			</span>
		);
	}
	if (!failed && asset.type === "video") {
		return (
			<span className="asset-thumbnail media-thumbnail video-thumbnail">
				<video
					key={url}
					src={videoFrameUrl(url)}
					muted
					playsInline
					preload="metadata"
					onLoadedMetadata={(event) => revealVideoFrame(event.currentTarget)}
					onError={() => setFailedUrl(url)}
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
		video.playsInline = true;
		video.tabIndex = -1;
		video.preload = "metadata";
		video.addEventListener("loadedmetadata", () => revealVideoFrame(video));
		video.addEventListener("error", () => paintBadge(wrap, asset));
		video.src = videoFrameUrl(url);
		wrap.append(video);
		return wrap;
	}
	paintBadge(wrap, asset);
	return wrap;
}
