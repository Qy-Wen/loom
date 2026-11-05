import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { useMemo } from "react";
import { prepareAssistantContent } from "../../shared/assistant-asset-refs.ts";
import { useLibraryAssets, useOpenAsset } from "./asset-open.tsx";

/** Assistant markdown. An `<asset_ref>` block links by asset id, then by path. */
export const AssistantMarkdown: typeof CopilotChatAssistantMessage.MarkdownRenderer = ({ content, ...props }) => {
	const library = useLibraryAssets();
	const { markdown, rawTail } = useMemo(
		() => prepareAssistantContent(content ?? "", library),
		[content, library],
	);
	return (
		<>
			{markdown ? (
				<CopilotChatAssistantMessage.MarkdownRenderer
					{...props}
					content={markdown}
					components={{ a: AssistantAssetLink }}
				/>
			) : null}
			{rawTail ? <span className="assistant-asset-raw">{rawTail}</span> : null}
		</>
	);
};

function AssistantAssetLink({ href, children }: { href?: string; children?: React.ReactNode }) {
	const openAsset = useOpenAsset();
	const library = useLibraryAssets();
	if (href?.startsWith("#loom-missing:")) {
		return <span className="asset-path asset-path-missing">{children}</span>;
	}
	if (href?.startsWith("#loom-asset:")) {
		const assetId = decodeHref(href.slice("#loom-asset:".length));
		const asset = library.get(assetId);
		if (!asset) return <span className="asset-path asset-path-missing">{children}</span>;
		return (
			<button type="button" className="asset-ref asset-path" data-tooltip={asset.path} onClick={() => openAsset(assetId)}>
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
