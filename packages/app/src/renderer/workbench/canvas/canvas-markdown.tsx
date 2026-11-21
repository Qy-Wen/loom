import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { useLocale } from "../../locale.tsx";
import { EMBED_IMAGE_SELECTOR } from "../preview/embed-renderers.ts";
import { embeddedReference, hydrateMarkdownNoteEmbeds } from "../preview/markdown-note-embed.ts";
import { renderMarkdown } from "../preview/markdown.ts";

const PREVIEW_BYTES = 16 * 1024;
type Excerpt = { text: string; truncated: boolean };

export const CanvasMarkdown = memo(function CanvasMarkdown({ asset, assets, onOpenAsset }: {
	asset: Asset;
	assets: Asset[];
	onOpenAsset(asset: Asset): void;
}): React.JSX.Element {
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

	const context = useMemo(() => ({
		fromRelativePath: asset.relativePath,
		assets,
		lazyImages: true,
	}), [asset.relativePath, assets]);
	// Keep the same HTML object across ordinary Canvas renders so React preserves the hydrated notes.
	const markup = useMemo(() => excerpt?.text ? { __html: renderMarkdown(excerpt.text, context) } : undefined, [context, excerpt]);
	useEffect(() => {
		if (!markup || !root.current) return;
		const controller = new AbortController();
		void hydrateMarkdownNoteEmbeds(root.current, context, controller.signal);
		return () => controller.abort();
	}, [context, markup]);
	const openImageMenu = (event: React.MouseEvent | React.KeyboardEvent) => {
		const image = event.target instanceof Element ? event.target.closest<HTMLImageElement>(EMBED_IMAGE_SELECTOR) : null;
		if (!image) return;
		event.preventDefault();
		event.stopPropagation();
		const target = assets.find((item) => item.assetId === image.dataset.embedImageId);
		if (!target) return;
		void window.loom.showEditorContextMenu({ embed: true, readOnly: true, canUndo: false, canRedo: false, canCopy: false, formats: {} }).then((action) => {
			if (action === "open_embed" && image.isConnected) onOpenAsset(target);
		}).catch(() => undefined);
	};

	return (
		<div className="canvas-note canvas-file-markdown thin-scroll" ref={root} onContextMenu={openImageMenu} onKeyDown={(event) => {
			if (event.shiftKey && event.key === "F10") openImageMenu(event);
		}} onDoubleClick={(event) => {
			if (event.target instanceof Element && event.target.matches(EMBED_IMAGE_SELECTOR)) event.stopPropagation();
		}} onClick={(event) => {
			const reference = embeddedReference(event.target);
			if (!reference) return;
			event.preventDefault();
			const target = assets.find((item) => item.assetId === reference.assetId);
			if (target) onOpenAsset(target);
		}}>
			{markup ? <div className="markdown-preview-body" dangerouslySetInnerHTML={markup} /> :
				<span className="canvas-markdown-status">
					{excerpt === undefined ? t.preview.loadingMarkdown : excerpt === null ? t.canvas.markdownFailed : t.canvas.markdownEmpty}
				</span>}
			{excerpt?.truncated && <p className="canvas-markdown-status">{t.canvas.markdownExcerpt}</p>}
		</div>
	);
});
