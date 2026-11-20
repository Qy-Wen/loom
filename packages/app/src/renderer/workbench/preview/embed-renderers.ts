import type { Asset } from "@loom/core";
import type { WikiLinkMatch } from "@loom/core/references";
import { assetPreviewUrl, extensionOf } from "../../assets/asset-utils.ts";

type WikiTarget = Pick<WikiLinkMatch, "target" | "label">;

interface EmbedContent {
	asset: Asset;
	label: string;
	extension: string;
	href: string;
	src: string;
	standalone: boolean;
}

interface EmbedRenderer {
	matches(asset: Asset): boolean;
	render(content: EmbedContent): string;
	standaloneOnly?: boolean;
}

export const EMBED_LINK_SELECTOR = "a[data-embed-link]";
export const EMBED_IMAGE_SELECTOR = "img[data-embed-image-id]";
export const FILE_LINK_CLASS = "markdown-file-link";
export const FILE_EXTENSION_CLASS = "markdown-file-link-extension";

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function fileExtensionLabel(asset: Asset, { target, label }: WikiTarget): string {
	if (label) return "";
	const extension = extensionOf(asset.filename);
	return extensionOf(target || asset.filename) === extension ? "" : extension.slice(1);
}

export function renderFileExtension(extension: string): string {
	return extension ? `<small class="${FILE_EXTENSION_CLASS}">${escapeHtml(extension)}</small>` : "";
}

function fileCard({ href, label, extension }: EmbedContent): string {
	return `<a class="markdown-embed-file ${FILE_LINK_CLASS}" ${href}><span>${label}</span>${renderFileExtension(extension)}</a>`;
}

function mediaBlock(embed: EmbedContent, preview: string): string {
	return `<span class="markdown-embed-media">${preview}${fileCard(embed)}</span>`;
}

function imagePreview(embed: EmbedContent): string {
	const { asset, src, label, standalone } = embed;
	const image = `<img class="cm-live-image markdown-embed-image" data-embed-image-id="${escapeHtml(asset.assetId)}" src="${src}" alt="${label}" loading="lazy" draggable="false" tabindex="0">`;
	return standalone ? mediaBlock(embed, image) : image;
}

const renderers: readonly EmbedRenderer[] = [
	{
		matches: (asset) => asset.type === "image",
		render: imagePreview,
	},
	{
		matches: (asset) => asset.type === "video",
		standaloneOnly: true,
		render: (embed) => mediaBlock(embed, `<video src="${embed.src}" aria-label="${embed.label}" controls playsinline preload="none" loading="lazy" width="640" height="360"></video>`),
	},
	{
		matches: (asset) => asset.type === "audio",
		standaloneOnly: true,
		render: (embed) => mediaBlock(embed, `<audio src="${embed.src}" aria-label="${embed.label}" controls preload="none" loading="lazy"></audio>`),
	},
];

/** Shared by the editor's widget and rendered Markdown. Full-size players need their own line. */
export function renderAssetEmbed(asset: Asset, reference: WikiTarget, anchor: string | undefined, standalone: boolean): string {
	const renderer = renderers.find((item) => (standalone || !item.standaloneOnly) && item.matches(asset));
	const fragment = anchor ? ` data-anchor="${escapeHtml(anchor)}"` : "";
	return (renderer?.render ?? fileCard)({
		asset,
		label: escapeHtml(reference.label || reference.target || asset.filename),
		extension: fileExtensionLabel(asset, reference),
		href: `href="#" data-embed-link data-asset-id="${escapeHtml(asset.assetId)}"${fragment}`,
		src: escapeHtml(assetPreviewUrl(asset)),
		standalone,
	});
}

export function embedOccupiesLine(text: string, from: number, to: number): boolean {
	const start = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
	const end = text.indexOf("\n", to);
	return !text.slice(start, from).trim() && !text.slice(to, end < 0 ? text.length : end).trim();
}
