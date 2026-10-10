import { useEffect, useRef, useState } from "react";
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

function PreviewFallback({ asset, message }: { asset: Asset; message: string }): React.JSX.Element {
	return (
		<div className="preview-placeholder">
			<div className="preview-icon">{asset.type.toUpperCase()}</div>
			<strong>{asset.filename}</strong>
			<span>{message}</span>
		</div>
	);
}

function TextPreview({ asset, url }: { asset: Asset; url: string }): React.JSX.Element {
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

	if (tooLarge) return <PreviewFallback asset={asset} message={t.preview.tooLarge} />;
	if (failure) return <PreviewFallback asset={asset} message={failure} />;
	if (content === null) return <div className="preview-loading">{t.preview.loadingText}</div>;
	return (
		<div className="text-workbench">
			<FindBar rootRef={contentRef} assetId={asset.assetId} documentKey={content} />
			<pre className="text-preview" ref={contentRef}>{content}</pre>
		</div>
	);
}

function VideoPreview({ asset, url }: { asset: Asset; url: string }): React.JSX.Element {
	const { t } = useLocale();
	const [status, setStatus] = useState<"pending" | "ready" | "failed">("pending");

	if (status === "failed") {
		return <PreviewFallback asset={asset} message={t.preview.electronFailed} />;
	}
	return (
		<div className="media-preview video-preview">
			<video
				className={status === "ready" ? undefined : "pending"}
				controls={status === "ready"}
				preload="metadata"
				onLoadedMetadata={() => setStatus("ready")}
				onError={() => setStatus("failed")}
			>
				<source src={url} />
			</video>
		</div>
	);
}

export function AssetPreview({
	asset,
	assets,
	onGraded,
	gradeHost = null,
}: {
	asset: Asset;
	assets: Asset[];
	onGraded?: (assetId: string) => void;
	gradeHost?: HTMLElement | null;
}): React.JSX.Element {
	const { t } = useLocale();
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);
	const extension = extensionOf(asset.filename);

	useEffect(() => setFailed(false), [asset.assetId]);

	if (asset.type === "image" && isGradeableImage(asset.filename)) {
		return <GradeView asset={asset} assets={assets} onGraded={onGraded} panelHost={gradeHost} />;
	}
	if (asset.type === "video") {
		return <VideoPreview key={asset.assetId} asset={asset} url={url} />;
	}
	if (failed) {
		return <PreviewFallback asset={asset} message={t.preview.electronFailed} />;
	}
	if (asset.type === "image") {
		return (
			<div className="media-preview image-preview">
				<img src={url} alt={asset.filename} onError={() => setFailed(true)} />
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
			</div>
		);
	}
	if (extension === ".pdf") {
		return <iframe className="pdf-preview" src={url} title={t.preview.title(asset.filename)} />;
	}
	if (extension === ".md") return <MarkdownPreview asset={asset} assets={assets} url={url} />;
	if (TEXT_EXTENSIONS.has(extension)) return <TextPreview asset={asset} url={url} />;
	return <PreviewFallback asset={asset} message={t.preview.unavailable} />;
}
