import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Asset } from "@loom/core";
import { useLocale } from "../locale.tsx";
import { assetPreviewUrl, extensionOf } from "../assets/asset-utils.ts";
import { isGradeableImage } from "@loom/core/grade";
import { FindBar } from "./find-bar.tsx";
import { GradeView } from "./grade-view.tsx";
import { MarkdownPreview } from "./markdown-preview.tsx";

const TEXT_EXTENSIONS = new Set([
	".css", ".csv", ".html", ".ini", ".js", ".json", ".jsx", ".log",
	".py", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

function PreviewFallback({ asset, message, actions = null }: { asset: Asset; message: string; actions?: ReactNode }): React.JSX.Element {
	return (
		<div className="preview-placeholder">
			<div className="preview-icon">{asset.type.toUpperCase()}</div>
			<strong>{asset.filename}</strong>
			<span>{message}</span>
			{actions}
		</div>
	);
}

function TextPreview({ asset, url, actions = null }: { asset: Asset; url: string; actions?: ReactNode }): React.JSX.Element {
	const { t } = useLocale();
	const contentRef = useRef<HTMLPreElement>(null);
	const [content, setContent] = useState<string | null>(null);
	const [tooLarge, setTooLarge] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setContent(null);
		setFailure(null);
		setTooLarge(false);
		if (asset.size > 2 * 1_024 * 1_024) {
			setTooLarge(true);
			return () => controller.abort();
		}
		void fetch(url, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
				return response.text();
			})
			.then(setContent)
			.catch((cause) => {
				if (!controller.signal.aborted) {
					setFailure(cause instanceof Error ? cause.message : String(cause));
				}
			});
		return () => controller.abort();
	}, [asset.assetId, asset.size, url]);

	if (tooLarge) return <PreviewFallback asset={asset} message={t.preview.tooLarge} actions={actions} />;
	if (failure) return <PreviewFallback asset={asset} message={failure} actions={actions} />;
	if (content === null) return <div className="preview-loading">{t.preview.loadingText}</div>;
	return (
		<div className="text-workbench">
			<FindBar rootRef={contentRef} assetId={asset.assetId} documentKey={content} />
			<pre className="text-preview" ref={contentRef}>{content}</pre>
			{actions}
		</div>
	);
}

function VideoPreview({ asset, url, actions = null }: { asset: Asset; url: string; actions?: ReactNode }): React.JSX.Element {
	const { t } = useLocale();
	const [status, setStatus] = useState<"pending" | "ready" | "failed">("pending");

	if (status === "failed") {
		return <PreviewFallback asset={asset} message={t.preview.electronFailed} actions={actions} />;
	}
	return (
		<div className="media-preview video-preview">
			<div className="preview-stack">
			<video
				className={status === "ready" ? undefined : "pending"}
				controls={status === "ready"}
				preload="metadata"
				onLoadedMetadata={() => setStatus("ready")}
				onError={() => setStatus("failed")}
			>
				<source src={url} />
			</video>
			{actions}
			</div>
		</div>
	);
}

export function AssetPreview({
	asset,
	assets,
	onGraded,
	gradeHost = null,
	actions = null,
}: {
	asset: Asset;
	assets: Asset[];
	onGraded?: (assetId: string) => void;
	gradeHost?: HTMLElement | null;
	actions?: ReactNode;
}): React.JSX.Element {
	const { t } = useLocale();
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);
	const extension = extensionOf(asset.filename);

	useEffect(() => setFailed(false), [asset.assetId]);

	if (asset.type === "image" && isGradeableImage(asset.filename)) {
		return <GradeView asset={asset} assets={assets} onGraded={onGraded} panelHost={gradeHost} actions={actions} />;
	}
	if (asset.type === "video") {
		return <VideoPreview key={asset.assetId} asset={asset} url={url} actions={actions} />;
	}
	if (failed) {
		return <PreviewFallback asset={asset} message={t.preview.electronFailed} actions={actions} />;
	}
	if (asset.type === "image") {
		return (
			<div className="media-preview image-preview">
				<div className="preview-stack">
					<img src={url} alt={asset.filename} onError={() => setFailed(true)} />
					{actions}
				</div>
			</div>
		);
	}
	if (asset.type === "audio") {
		return (
			<div className="audio-preview">
				<div className="audio-art">♪</div>
				<strong>{asset.filename}</strong>
				<audio key={url} controls preload="metadata" onError={() => setFailed(true)}>
					<source src={url} />
				</audio>
				{actions}
			</div>
		);
	}
	if (extension === ".pdf") {
		return <iframe className="pdf-preview" src={url} title={t.preview.title(asset.filename)} />;
	}
	if (extension === ".md") return <MarkdownPreview asset={asset} assets={assets} url={url} />;
	if (TEXT_EXTENSIONS.has(extension)) return <TextPreview asset={asset} url={url} actions={actions} />;
	return <PreviewFallback asset={asset} message={t.preview.unavailable} actions={actions} />;
}

/** Icon actions under the preview. Edit is only offered for a gradeable image. */
export function PreviewActions({
	canEdit,
	favorite,
	onEdit,
	onToggleFavorite,
	onDelete,
}: {
	canEdit: boolean;
	favorite: boolean;
	onEdit: () => void;
	onToggleFavorite: () => void;
	onDelete: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	const favoriteLabel = favorite ? t.menu.removeFromFavorites : t.menu.addToFavorites;
	return (
		<div className="preview-actions">
			{canEdit && (
				<button type="button" title={t.common.edit} aria-label={t.common.edit} onClick={onEdit}>
					<PencilIcon />
				</button>
			)}
			<button
				type="button"
				title={favoriteLabel}
				aria-label={favoriteLabel}
				aria-pressed={favorite}
				onClick={onToggleFavorite}
			>
				<StarIcon filled={favorite} />
			</button>
			<button type="button" className="danger" title={t.common.delete} aria-label={t.common.delete} onClick={onDelete}>
				<TrashIcon />
			</button>
		</div>
	);
}

function PencilIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" d="M9.6 2.2 13.8 6.4 5.4 14.8H1.2v-4.2L9.6 2.2z" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="M8.2 3.6 12.4 7.8" />
		</svg>
	);
}

function StarIcon({ filled }: { filled: boolean }): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path
				fill={filled ? "currentColor" : "none"}
				stroke="currentColor"
				strokeWidth="1.2"
				strokeLinejoin="round"
				d="M8 1.7 9.8 5.6l4.3.4-3.3 2.8.1 4.3L8 11.2 5.1 13.1l.1-4.3L1.9 6l4.3-.4L8 1.7z"
			/>
		</svg>
	);
}

function TrashIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" d="M3 4.2h10M6.2 4.2V2.8h3.6v1.4M4.3 4.2l.5 9h6.4l.5-9M6.6 6.4v4.6M9.4 6.4v4.6" />
		</svg>
	);
}
