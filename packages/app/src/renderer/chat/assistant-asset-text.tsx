import { Markdown, type MarkdownLinkProps } from "@loom/ag-ui-react/markdown";
import "@loom/ag-ui-react/markdown.css";
import { useMemo } from "react";
import { prepareAssistantContent } from "../../shared/assistant-asset-refs.ts";
import { useLibraryAssets, useLibraryFolders, useOpenReference } from "./asset-open.tsx";

/** Assistant markdown. An `<asset_ref>` block links by asset id, then by path. */
export function AssistantMarkdown({ content }: { content: string }) {
	const library = useLibraryAssets();
	const folders = useLibraryFolders();
	const { markdown, rawTail } = useMemo(
		() => prepareAssistantContent(content, library, folders),
		[content, library, folders],
	);
	return (
		<>
			{markdown && <Markdown content={markdown} className="chat-markdown" linkComponent={AssistantAssetLink} />}
			{rawTail ? <span className="assistant-asset-raw">{rawTail}</span> : null}
		</>
	);
}

function AssistantAssetLink({ href, children }: MarkdownLinkProps) {
	const openReference = useOpenReference();
	const library = useLibraryAssets();
	const folders = useLibraryFolders();
	if (href?.startsWith("#loom-folder:")) {
		const path = decodeHref(href.slice("#loom-folder:".length));
		if (!folders.has(path)) return <span className="asset-path asset-path-missing">{children}</span>;
		return <button type="button" className="asset-ref asset-path folder-ref" data-tooltip={path} onClick={() => openReference({ type: "folder_ref", path })}>{children}</button>;
	}
	if (href?.startsWith("#loom-missing:")) {
		return <span className="asset-path asset-path-missing">{children}</span>;
	}
	if (href?.startsWith("#loom-asset:")) {
		const assetId = decodeHref(href.slice("#loom-asset:".length));
		const asset = library.get(assetId);
		if (!asset) return <span className="asset-path asset-path-missing">{children}</span>;
		return (
			<button type="button" className="asset-ref asset-path" data-tooltip={asset.path} onClick={() => openReference({ type: "asset_ref", assetId, path: asset.path, assetType: asset.type })}>
				{children}
			</button>
		);
	}
	return <a href={href}>{children}</a>;
}

function decodeHref(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
