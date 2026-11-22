import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { Asset } from "@loom/core";
import { isHtmlFile, isPlainTextFile } from "../../../shared/text-file.ts";
import { useLocale } from "../../locale.tsx";
import { assetPreviewUrl, extensionOf } from "../../assets/asset-utils.ts";
import { isGradeableImage, isGradeableVideo } from "@loom/core/grade";
import type { RegisterMarkdownHistory } from "../asset-history.ts";
import { FavoriteButton } from "./favorite-button.tsx";
import { MediaFullscreenButton, MediaViewport } from "./media-viewport.tsx";

const GradeView = lazy(() => import("./grade-view.tsx").then(({ GradeView }) => ({ default: GradeView })));
const MarkdownEditor = lazy(() => import("./markdown-editor.tsx").then(({ MarkdownEditor }) => ({ default: MarkdownEditor })));
const TextWorkbench = lazy(() => import("./text-workbench.tsx").then(({ TextWorkbench }) => ({ default: TextWorkbench })));

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

function VideoPreview({ asset, url, actions = null }: { asset: Asset; url: string; actions?: ReactNode }): React.JSX.Element {
	const { t } = useLocale();
	const [status, setStatus] = useState<"pending" | "ready" | "failed">("pending");

	if (status === "failed") {
		return <PreviewFallback asset={asset} message={t.preview.electronFailed} actions={actions} />;
	}
	return (
		<div className="media-preview video-preview">
			<div className="preview-stack">
				<MediaViewport assetId={asset.assetId} kind="video" actions={actions}>
					<video
						className={status === "ready" ? undefined : "pending"}
						preload="metadata"
						playsInline
						onLoadedMetadata={() => setStatus("ready")}
						onError={() => setStatus("failed")}
					>
						<source src={url} />
					</video>
				</MediaViewport>
			</div>
		</div>
	);
}

export function AssetPreview({
	asset,
	assets,
	favorite,
	onToggleFavorite,
	onGraded,
	onOpenAsset,
	registerMarkdown,
	gradeHost = null,
	grading = false,
	actions = null,
}: {
	asset: Asset;
	assets: Asset[];
	favorite: boolean;
	onToggleFavorite: () => void;
	onGraded?: (assetId: string) => void;
	/** Follows a Markdown reference to a file or heading. */
	onOpenAsset?: (assetId: string, heading?: string) => void;
	registerMarkdown?: RegisterMarkdownHistory;
	gradeHost?: HTMLElement | null;
	grading?: boolean;
	actions?: ReactNode;
}): React.JSX.Element {
	const { t } = useLocale();
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);
	const extension = extensionOf(asset.filename);

	useEffect(() => setFailed(false), [asset.assetId]);

	if (grading && ((asset.type === "image" && isGradeableImage(asset.filename)) || (asset.type === "video" && isGradeableVideo(asset.filename)))) {
		return (
			<Suspense fallback={<div className="preview-loading" role="status">{t.common.loading}</div>}>
				<GradeView asset={asset} assets={assets} onGraded={onGraded} panelHost={gradeHost} actions={actions} />
			</Suspense>
		);
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
					<MediaViewport assetId={asset.assetId} kind="image">
						<img src={url} alt={asset.filename} draggable={false} onError={() => setFailed(true)} />
					</MediaViewport>
					<div className="image-toolbar">
						{actions}
						<MediaFullscreenButton />
					</div>
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
	if (extension === ".md") {
		return (
			<Suspense fallback={<div className="preview-loading" role="status">{t.preview.loadingText}</div>}>
				<MarkdownEditor key={asset.assetId} asset={asset} assets={assets} favorite={favorite} onToggleFavorite={onToggleFavorite}
					onOpenAsset={onOpenAsset} registerMarkdown={registerMarkdown} />
			</Suspense>
		);
	}
	const html = isHtmlFile(asset.filename);
	if (html || isPlainTextFile(asset.filename)) {
		return (
			<Suspense fallback={<div className="preview-loading" role="status">{t.common.loading}</div>}>
				<TextWorkbench key={`${html}:${asset.assetId}`} asset={asset} html={html} favorite={favorite} onToggleFavorite={onToggleFavorite} />
			</Suspense>
		);
	}
	return <PreviewFallback asset={asset} message={t.preview.unavailable} actions={actions} />;
}

/** Icon actions under the preview. Grade is a mode for stills and video, not the default view. */
export function PreviewActions({
	canGrade = false,
	grading = false,
	leaveVideo = false,
	favorite,
	onGrade,
	onLeaveGrade,
	onToggleFavorite,
	onDelete,
}: {
	canGrade?: boolean;
	grading?: boolean;
	leaveVideo?: boolean;
	favorite: boolean;
	onGrade?: () => void;
	onLeaveGrade?: () => void;
	onToggleFavorite: () => void;
	onDelete: () => void;
}): React.JSX.Element {
	const { t } = useLocale();
	return (
		<div className="preview-actions">
			{canGrade && !grading && (
				<button type="button" data-tooltip={t.common.edit} aria-label={t.common.edit} onClick={onGrade}>
					<PencilIcon />
				</button>
			)}
			{canGrade && grading && (
				<button type="button" data-tooltip={t.grade.leave} aria-label={t.grade.leave} onClick={onLeaveGrade}>
					{leaveVideo ? <LeaveGradeIcon /> : <LeaveStillIcon />}
				</button>
			)}
			<FavoriteButton favorite={favorite} onToggle={onToggleFavorite} />
			<button type="button" className="danger" data-tooltip={t.common.delete} aria-label={t.common.delete} onClick={onDelete}>
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

function LeaveGradeIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<rect x="2" y="2.6" width="12" height="10.8" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" d="M5 2.6v10.8M11 2.6v10.8" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="M2 5.4h3M2 8h3M2 10.6h3M11 5.4h3M11 8h3M11 10.6h3" />
		</svg>
	);
}

function LeaveStillIcon(): React.JSX.Element {
	return (
		<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
			<rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
			<path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" d="m3.4 11 2.6-2.4 1.8 1.6 1.5-1.3L12.6 11" />
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
