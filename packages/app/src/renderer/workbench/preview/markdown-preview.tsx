import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { useLocale } from "../../locale.tsx";
import { FindBar } from "./find-bar.tsx";
import { renderMarkdown } from "./markdown.ts";
import { hydrateMermaid } from "./mermaid.ts";

type MarkdownMode = "preview" | "source";

const MarkdownRenderedBody = memo(function MarkdownRenderedBody({
	html,
	onHydrated,
}: {
	html: string;
	onHydrated: () => void;
}): React.JSX.Element {
	const bodyRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const root = bodyRef.current;
		if (!root) return;
		let cancelled = false;
		void hydrateMermaid(root).then((rendered) => {
			if (!cancelled && rendered) onHydrated();
		});
		return () => {
			cancelled = true;
		};
	}, [html, onHydrated]);
	return <div className="markdown-preview-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />;
});

export function MarkdownPreview({
	asset,
	assets,
	url,
}: {
	asset: Asset;
	assets: Asset[];
	url: string;
}): React.JSX.Element {
	const { t } = useLocale();
	const [content, setContent] = useState<string | null>(null);
	const [tooLarge, setTooLarge] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	const [mode, setMode] = useState<MarkdownMode>("preview");
	const html = useMemo(
		() => (content === null ? "" : renderMarkdown(content, { fromRelativePath: asset.relativePath, assets })),
		[asset.relativePath, assets, content],
	);
	const contentRef = useRef<HTMLDivElement>(null);
	const [diagramsKey, setDiagramsKey] = useState(0);
	const onHydrated = useCallback(() => setDiagramsKey((key) => key + 1), []);

	useEffect(() => {
		const controller = new AbortController();
		setContent(null);
		setFailure(null);
		setTooLarge(false);
		setMode("preview");
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

	if (tooLarge || failure) {
		return (
			<div className="preview-placeholder">
				<div className="preview-icon">MD</div>
				<strong>{asset.filename}</strong>
				<span>{tooLarge ? t.preview.tooLarge : failure}</span>
			</div>
		);
	}
	if (content === null) return <div className="preview-loading">{t.preview.loadingMarkdown}</div>;

	return (
		<div className="markdown-workbench">
			<div className="markdown-toolbar" role="tablist" aria-label={t.preview.markdownView}>
				<button
					className={mode === "preview" ? "active" : ""}
					role="tab"
					aria-selected={mode === "preview"}
					type="button"
					onClick={() => setMode("preview")}
				>
					{t.preview.preview}
				</button>
				<button
					className={mode === "source" ? "active" : ""}
					role="tab"
					aria-selected={mode === "source"}
					type="button"
					onClick={() => setMode("source")}
				>
					{t.preview.source}
				</button>
			</div>
			<FindBar rootRef={contentRef} assetId={asset.assetId} documentKey={`${mode}:${html}:${diagramsKey}`} />
			<div
				className={mode === "preview" ? "markdown-preview thin-scroll" : "text-preview thin-scroll"}
				ref={contentRef}
			>
				{mode === "preview" ? <MarkdownRenderedBody html={html} onHydrated={onHydrated} /> : content}
			</div>
		</div>
	);
}
