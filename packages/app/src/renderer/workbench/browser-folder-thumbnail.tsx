import { AssetThumbnail } from "../assets/asset-thumbnail.tsx";
import { assetBadgeLabel } from "../assets/asset-utils.ts";
import type { BrowserFolderPreview } from "./browser-folder-preview.ts";

/** Flat browser artwork, independent of the sidebar's small line icon. */
export function BrowserFolderThumbnail({ preview }: { preview?: BrowserFolderPreview }): React.JSX.Element {
	const asset = preview?.kind === "asset" ? preview.asset : null;
	return (
		<span className={`browser-folder-art${preview ? " has-content" : " empty"}`} aria-hidden="true">
			<svg className="browser-folder-back" viewBox="0 0 100 88">
				<path d="M10 74V18a6 6 0 0 1 6-6h22l8 9h38a6 6 0 0 1 6 6v47a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6Z" fill="var(--browser-folder-back-fill)" />
			</svg>
			{preview ? (
				<span className={`browser-folder-content ${asset ? `type-${asset.type}` : "subfolder"}`} data-preview-asset-id={asset?.assetId}>
					{asset && (asset.type === "image" || asset.type === "video") ? <AssetThumbnail key={asset.assetId} asset={asset} /> : asset ? (
						<span className="browser-folder-file">
							<svg viewBox="0 0 48 56">
								<path d="M5 1h28l14 14v36a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V5a4 4 0 0 1 4-4Z" fill="var(--lm-surface-raised)" stroke="var(--lm-border-strong)" />
								<path d="M33 1v14h14" fill="none" stroke="var(--lm-border-strong)" />
							</svg>
							<span className="browser-folder-file-label">{assetBadgeLabel(asset.filename, asset.type)}</span>
						</span>
					) : (
						<svg className="browser-folder-child" viewBox="0 0 48 40">
							<path d="M3 33V7a3 3 0 0 1 3-3h11l5 5h20a3 3 0 0 1 3 3v21a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z" fill="var(--browser-folder-child-fill)" />
						</svg>
					)}
				</span>
			) : null}
			<svg className="browser-folder-front" viewBox="0 0 100 88">
				<path d="M14 40h72a4 4 0 0 1 4 4v30a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6V44a4 4 0 0 1 4-4Z" fill="var(--browser-folder-front-fill)" />
			</svg>
		</span>
	);
}
