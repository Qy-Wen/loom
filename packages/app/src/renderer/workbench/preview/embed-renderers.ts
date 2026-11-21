import type { Asset } from "@loom/core";
import type { WikiLinkMatch } from "@loom/core/references";
import { markdownEmbedLayout } from "../../../shared/markdown-reference.ts";
import { assetPosterUrl, assetPreviewUrl, extensionOf } from "../../assets/asset-utils.ts";

type WikiTarget = Pick<WikiLinkMatch, "target" | "label">;

interface EmbedContent {
	asset: Asset;
	label: string;
	extension: string;
	href: string;
	src: string;
	compact: boolean;
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
	const { asset, src, label, compact } = embed;
	const image = `<img class="cm-live-image markdown-embed-image" data-embed-image-id="${escapeHtml(asset.assetId)}" src="${src}" alt="${label}" loading="lazy" draggable="false" tabindex="0">`;
	return compact ? image : mediaBlock(embed, image);
}

function videoPreview(embed: EmbedContent): string {
	const poster = escapeHtml(assetPosterUrl(embed.asset));
	// The poster image sizes the player even after the browser switches to video frames.
	const sizingImage = `<img src="${poster}" alt="" aria-hidden="true" loading="lazy" width="640" height="360">`;
	const player = `<video src="${embed.src}" poster="${poster}" aria-label="${embed.label}" controls playsinline preload="none" loading="lazy"></video>`;
	return mediaBlock(embed, `<span class="markdown-embed-video">${sizingImage}${player}</span>`);
}

const renderers: Partial<Record<Asset["type"], (content: EmbedContent) => string>> = {
	image: imagePreview,
	video: videoPreview,
	audio: (embed) => mediaBlock(embed, `<audio src="${embed.src}" aria-label="${embed.label}" controls preload="none" loading="lazy"></audio>`),
};

/** Shared by the editor and rendered Markdown. Table cells use compact embeds. */
export function renderAssetEmbed(asset: Asset, reference: WikiTarget, anchor: string | undefined, compact = false): string {
	const renderer = compact && markdownEmbedLayout(asset.type) === "block" ? undefined : renderers[asset.type];
	const fragment = anchor ? ` data-anchor="${escapeHtml(anchor)}"` : "";
	return (renderer ?? fileCard)({
		asset,
		label: escapeHtml(reference.label || reference.target || asset.filename),
		extension: fileExtensionLabel(asset, reference),
		href: `href="#" data-embed-link data-asset-id="${escapeHtml(asset.assetId)}"${fragment}`,
		src: escapeHtml(assetPreviewUrl(asset)),
		compact,
	});
}
