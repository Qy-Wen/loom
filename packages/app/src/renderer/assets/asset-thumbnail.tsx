import { useState } from "react";
import type { Asset } from "@loom/core";
import { assetBadgeLabel, assetPosterUrl, assetPreviewUrl, assetThumbnailUrl } from "./asset-utils.ts";

export type AssetPreview = {
	assetId: string;
	filename: string;
	type: Asset["type"];
	modifiedAt?: number;
	size?: number;
};

/**
 * Cached media preview with square and uncropped variants. Images without a cached preview, such as SVGs,
 * fall back to the original file. Other assets and failed previews show a type badge.
 */
export function AssetThumbnail({ asset, variant = "square", onMediaLoad }: {
	asset: AssetPreview;
	variant?: "square" | "poster";
	onMediaLoad?: (width: number, height: number) => void;
}): React.JSX.Element {
	const [failedUrls, setFailedUrls] = useState<readonly string[]>([]);
	const thumbnail = variant === "poster" ? assetPosterUrl(asset) : assetThumbnailUrl(asset);
	const original = assetPreviewUrl(asset);
	const url = [thumbnail, ...(asset.type === "image" ? [original] : [])].find((candidate) => !failedUrls.includes(candidate));

	if (url && (asset.type === "image" || asset.type === "video")) {
		return (
			<span className={`asset-thumbnail media-thumbnail${asset.type === "video" ? " video-thumbnail" : ""}`}>
				<img key={url} src={url} alt="" loading="lazy" decoding="async"
					onLoad={onMediaLoad && (({ currentTarget }) => onMediaLoad(currentTarget.naturalWidth, currentTarget.naturalHeight))}
					onError={() => setFailedUrls((current) => [...current, url])} />
			</span>
		);
	}

	return <span className={`asset-thumbnail asset-badge type-${asset.type}`}>{assetBadgeLabel(asset.filename, asset.type)}</span>;
}
