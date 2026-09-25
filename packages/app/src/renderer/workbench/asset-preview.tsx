import { useEffect, useState } from "react";
import type { Asset } from "@loom/core";
import { assetPreviewUrl, extensionOf } from "../assets/asset-utils.ts";
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
	const [content, setContent] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setContent(null);
		setFailure(null);
		if (asset.size > 2 * 1_024 * 1_024) {
			setFailure("This text file is larger than 2 MB, so inline preview is disabled.");
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

	if (failure) return <PreviewFallback asset={asset} message={failure} />;
	if (content === null) return <div className="preview-loading">Loading text preview…</div>;
	return <pre className="text-preview">{content}</pre>;
}

export function AssetPreview({ asset, assets }: { asset: Asset; assets: Asset[] }): React.JSX.Element {
	const [failed, setFailed] = useState(false);
	const url = assetPreviewUrl(asset);
	const extension = extensionOf(asset.filename);

	useEffect(() => setFailed(false), [asset.assetId]);

	if (failed) {
		return <PreviewFallback asset={asset} message="This file format could not be previewed by Electron." />;
	}
	if (asset.type === "image") {
		return (
			<div className="media-preview image-preview">
				<img src={url} alt={asset.filename} onError={() => setFailed(true)} />
			</div>
		);
	}
	if (asset.type === "video") {
		return (
			<div className="media-preview video-preview">
				<video key={url} controls preload="metadata" onError={() => setFailed(true)}>
					<source src={url} />
				</video>
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
		return <iframe className="pdf-preview" src={url} title={`Preview ${asset.filename}`} />;
	}
	if (extension === ".md") return <MarkdownPreview asset={asset} assets={assets} url={url} />;
	if (TEXT_EXTENSIONS.has(extension)) return <TextPreview asset={asset} url={url} />;
	return <PreviewFallback asset={asset} message="No inline preview is available for this format yet." />;
}
