import { useEffect, useMemo, useState } from "react";
import type { Asset } from "@loom/core";
import { renderMarkdown } from "./markdown.ts";

type MarkdownMode = "preview" | "source";

export function MarkdownPreview({
	asset,
	assets,
	url,
}: {
	asset: Asset;
	assets: Asset[];
	url: string;
}): React.JSX.Element {
	const [content, setContent] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const [mode, setMode] = useState<MarkdownMode>("preview");
	const html = useMemo(
		() => (content === null ? "" : renderMarkdown(content, { fromRelativePath: asset.relativePath, assets })),
		[asset.relativePath, assets, content],
	);

	useEffect(() => {
		const controller = new AbortController();
		setContent(null);
		setFailure(null);
		setMode("preview");
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

	if (failure) {
		return (
			<div className="preview-placeholder">
				<div className="preview-icon">MD</div>
				<strong>{asset.filename}</strong>
				<span>{failure}</span>
			</div>
		);
	}
	if (content === null) return <div className="preview-loading">Loading markdown preview…</div>;

	return (
		<div className="markdown-workbench">
			<div className="markdown-toolbar" role="tablist" aria-label="Markdown view">
				<button
					className={mode === "preview" ? "active" : ""}
					role="tab"
					aria-selected={mode === "preview"}
					type="button"
					onClick={() => setMode("preview")}
				>
					Preview
				</button>
				<button
					className={mode === "source" ? "active" : ""}
					role="tab"
					aria-selected={mode === "source"}
					type="button"
					onClick={() => setMode("source")}
				>
					Source
				</button>
			</div>
			{mode === "preview" ? (
				<div className="markdown-preview">
					<div className="markdown-preview-body" dangerouslySetInnerHTML={{ __html: html }} />
				</div>
			) : (
				<pre className="text-preview">{content}</pre>
			)}
		</div>
	);
}
