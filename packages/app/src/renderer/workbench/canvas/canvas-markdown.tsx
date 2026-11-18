import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { useLocale } from "../../locale.tsx";
import { renderMarkdown } from "../preview/markdown.ts";

const PREVIEW_BYTES = 16 * 1024;
type Excerpt = { text: string; truncated: boolean };

export const CanvasMarkdown = memo(function CanvasMarkdown({ asset, assets }: { asset: Asset; assets: Asset[] }): React.JSX.Element {
	const { t } = useLocale();
	const root = useRef<HTMLDivElement>(null);
	const [visible, setVisible] = useState(false);
	const [result, setResult] = useState<{ url: string; excerpt: Excerpt | null }>();
	const url = assetPreviewUrl(asset);
	const excerpt = result?.url === url ? result.excerpt : undefined;

	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (!entry?.isIntersecting) return;
			setVisible(true);
			observer.disconnect();
		}, { root: element.closest(".canvas-surface"), rootMargin: "120px" });
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!visible) return;
		const controller = new AbortController();
		// Request one extra byte to detect truncation without needing Content-Range.
		void fetch(url, { signal: controller.signal, headers: { Range: `bytes=0-${PREVIEW_BYTES}` } })
			.then(async (response) => {
				if (!response.ok) throw new Error("Could not read Markdown");
				const bytes = new Uint8Array(await response.arrayBuffer());
				const truncated = bytes.length > PREVIEW_BYTES;
				const text = new TextDecoder().decode(bytes.subarray(0, PREVIEW_BYTES), { stream: truncated });
				if (!controller.signal.aborted) setResult({ url, excerpt: { text, truncated } });
			})
			.catch(() => {
				if (!controller.signal.aborted) setResult({ url, excerpt: null });
			});
		return () => controller.abort();
	}, [url, visible]);

	const html = useMemo(() => excerpt?.text && renderMarkdown(excerpt.text, {
		fromRelativePath: asset.relativePath,
		assets,
		lazyImages: true,
	}), [asset.relativePath, assets, excerpt]);

	return (
		<div className="canvas-note canvas-file-markdown thin-scroll" ref={root}>
			{html ? <div className="markdown-preview-body" dangerouslySetInnerHTML={{ __html: html }} /> :
				<span className="canvas-markdown-status">
					{excerpt === undefined ? t.preview.loadingMarkdown : excerpt === null ? t.canvas.markdownFailed : t.canvas.markdownEmpty}
				</span>}
			{excerpt?.truncated && <p className="canvas-markdown-status">{t.canvas.markdownExcerpt}</p>}
		</div>
	);
});
