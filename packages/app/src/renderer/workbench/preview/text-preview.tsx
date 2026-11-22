import type { Asset } from "@loom/core";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../locale.tsx";
import { FindBar } from "./find-bar.tsx";

const previewLimit = 2 * 1024 * 1024;

export function TextPreview({ asset, url }: { asset: Asset; url: string }): React.JSX.Element {
	const { t } = useLocale();
	const contentRef = useRef<HTMLPreElement>(null);
	const [content, setContent] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);
	const tooLarge = asset.size > previewLimit;

	useEffect(() => {
		setContent(null);
		setFailure(null);
		if (tooLarge) return;
		const controller = new AbortController();
		void fetch(url, { signal: controller.signal }).then(async (response) => {
			if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
			const length = Number(response.headers.get("Content-Length"));
			if (length > previewLimit) {
				await response.body?.cancel();
				throw new Error(t.preview.tooLarge);
			}
			const text = await response.text();
			if (!controller.signal.aborted) setContent(text);
		}).catch((cause: unknown) => {
			if (!controller.signal.aborted) setFailure(cause instanceof Error ? cause.message : String(cause));
		});
		return () => controller.abort();
	}, [t.preview.tooLarge, tooLarge, url]);

	if (tooLarge || failure) return (
		<div className="preview-placeholder" role={failure ? "alert" : "status"}>
			<strong>{asset.filename}</strong>
			<span>{tooLarge ? t.preview.tooLarge : failure}</span>
		</div>
	);
	if (content === null) return <div className="preview-loading" role="status">{t.preview.loadingText}</div>;
	return (
		<>
			<FindBar rootRef={contentRef} assetId={asset.assetId} documentKey={content} />
			<pre className="text-preview" ref={contentRef}>{content}</pre>
		</>
	);
}
