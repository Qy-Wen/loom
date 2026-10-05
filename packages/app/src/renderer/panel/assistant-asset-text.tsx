import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { useMemo } from "react";
import { prepareAssistantContent } from "../../shared/assistant-asset-refs.ts";
import { useLibraryAssets, useOpenAsset } from "./asset-open.tsx";

/** Assistant markdown, with library `<asset_ref>` blocks drawn as filename buttons. */
export const AssistantMarkdown: typeof CopilotChatAssistantMessage.MarkdownRenderer = ({ content, ...props }) => {
	const library = useLibraryAssets();
	const names = useMemo(() => {
		const map = new Map<string, string>();
		for (const [id, asset] of library) map.set(id, asset.filename);
		return map;
	}, [library]);
	const { markdown, rawTail } = useMemo(
		() => prepareAssistantContent(content ?? "", names),
		[content, names],
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
	if (href?.startsWith("#loom-asset:")) {
		const assetId = decodeAssetId(href.slice("#loom-asset:".length));
		const asset = library.get(assetId);
		if (!asset) return <span>{children}</span>;
		return (
			<button type="button" className="asset-ref" title={asset.path} onClick={() => openAsset(assetId)}>
				{children}
			</button>
		);
	}
	return <a href={href}>{children}</a>;
}

function decodeAssetId(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
