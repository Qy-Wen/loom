import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@loom/core";
import { useLocale } from "../../locale.tsx";
import { FindBar } from "./find-bar.tsx";
import { requestHeading, scrollToHeading, takePendingHeading } from "./heading-anchor.ts";
import { ANCHOR_ATTRIBUTE, ASSET_LINK_ATTRIBUTE, renderMarkdown } from "./markdown.ts";
import { MarkdownSourceEditor } from "./markdown-source-editor.tsx";
import { hydrateMermaid } from "./mermaid.ts";

type MarkdownMode = "preview" | "source";

const MarkdownRenderedBody = memo(function MarkdownRenderedBody({
	html,
	onHydrated,
	onOpenAsset,
	assetId,
}: {
	html: string;
	onHydrated: () => void;
	onOpenAsset?: (assetId: string) => void;
	/** The file being shown, so a link can tell whether it points back into it. */
	assetId: string;
}): React.JSX.Element {
	const bodyRef = useRef<HTMLDivElement>(null);
	// A link from another file may have asked for a heading here.
	useEffect(() => {
		if (bodyRef.current) takePendingHeading(assetId, bodyRef.current);
	}, [assetId, html]);
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
	return (
		<div
			className="markdown-preview-body"
			ref={bodyRef}
			onClick={(event) => {
				const link = (event.target as HTMLElement).closest<HTMLElement>("a");
				if (!link || !bodyRef.current?.contains(link) || link.getAttribute("href") !== "#") return;
				event.preventDefault();
				const target = link.getAttribute(ASSET_LINK_ATTRIBUTE);
				const anchor = link.getAttribute(ANCHOR_ATTRIBUTE);
				if (!target || target === assetId) {
					// A heading in this file.
					if (anchor && bodyRef.current) scrollToHeading(bodyRef.current, anchor);
					return;
				}
				if (anchor) requestHeading(target, anchor);
				onOpenAsset?.(target);
			}}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
});

export function MarkdownPreview({
	asset,
	assets,
	url,
	onOpenAsset,
}: {
	asset: Asset;
	assets: Asset[];
	url: string;
	onOpenAsset?: (assetId: string) => void;
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

	// Another file starts from a blank view; the same file refreshes in place, so saving from the editor
	// (which changes its size and address) does not tear the view down.
	useEffect(() => {
		setContent(null);
		setFailure(null);
		setMode("preview");
	}, [asset.assetId]);

	useEffect(() => {
		const controller = new AbortController();
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
			.then((text) => {
				setFailure(null);
				setContent(text);
			})
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
			{mode === "preview" ? (
				<>
					<FindBar rootRef={contentRef} assetId={asset.assetId} documentKey={`${html}:${diagramsKey}`} />
					<div className="markdown-preview thin-scroll" ref={contentRef}>
						<MarkdownRenderedBody html={html} onHydrated={onHydrated} onOpenAsset={onOpenAsset} assetId={asset.assetId} />
					</div>
				</>
			) : (
				<MarkdownSourceEditor assetId={asset.assetId} filename={asset.filename} modifiedAt={asset.modifiedAt} />
			)}
		</div>
	);
}
