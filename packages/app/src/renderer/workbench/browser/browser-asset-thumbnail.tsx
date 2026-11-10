import { useEffect, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { AssetThumbnail } from "../../assets/asset-thumbnail.tsx";
import { assetPreviewUrl, extensionOf } from "../../assets/asset-utils.ts";

/** The original is mounted only while hovered; every other tile keeps its cached still. */
export function BrowserAssetThumbnail({ asset, active }: { asset: Asset; active: boolean }): React.JSX.Element {
	const animate = active && (asset.type === "video" || (asset.type === "image" && extensionOf(asset.filename) === ".gif"));
	return <>
		<AssetThumbnail asset={asset} />
		{animate ? <AnimatedPreview key={assetPreviewUrl(asset)} asset={asset} /> : null}
	</>;
}

function AnimatedPreview({ asset }: { asset: Asset }): React.JSX.Element | null {
	const url = assetPreviewUrl(asset);
	const videoRef = useRef<HTMLVideoElement>(null);
	const [ready, setReady] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		let disposed = false;
		video.src = url;
		void video.play().catch(() => { if (!disposed) setFailed(true); });
		return () => {
			disposed = true;
			video.pause();
			video.removeAttribute("src");
			video.load();
		};
	}, [url, failed]);

	if (failed) return null;
	return (
		<span className={`asset-thumbnail media-thumbnail browser-hover-preview${ready ? " ready" : ""}`} aria-hidden="true">
			{asset.type === "video" ? (
				<video ref={videoRef} muted loop playsInline preload="metadata" onPlaying={() => setReady(true)} onError={() => setFailed(true)} />
			) : (
				<img src={url} alt="" onLoad={() => setReady(true)} onError={() => setFailed(true)} />
			)}
		</span>
	);
}
