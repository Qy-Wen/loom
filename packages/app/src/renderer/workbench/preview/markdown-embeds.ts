import type { Asset } from "@loom/core";
import { createAssetLookup } from "@loom/core/references";
import type { CanvasDocument } from "../../../shared/canvas.ts";
import { MARKDOWN_LIVE_LIMIT_BYTES } from "../../../shared/markdown-file.ts";
import { mountCanvasEmbed } from "../canvas/canvas-embed.ts";
import { CANVAS_EMBED_SELECTOR, EMBED_LINK_SELECTOR, NOTE_EMBED_SELECTOR } from "./embed-renderers.ts";
import { observeHtmlEmbeds } from "./markdown-html-embed.ts";
import { ASSET_LINK_ATTRIBUTE, ANCHOR_ATTRIBUTE, BROKEN_REFERENCE_CLASS, renderMarkdown, type MarkdownRenderContext } from "./markdown.ts";
import { hydrateMermaid } from "./mermaid.ts";

const sourceTexts = new WeakMap<Asset, Promise<string | undefined>>();
const canvasDocuments = new WeakMap<Asset, Promise<CanvasDocument | undefined>>();
const maximumDepth = 6;
const documentEmbedSelector = `${NOTE_EMBED_SELECTOR}, ${CANVAS_EMBED_SELECTOR}`;

function readSource(asset: Asset): Promise<string | undefined> {
	let pending = sourceTexts.get(asset);
	if (!pending) {
		pending = window.loom.readMarkdown(asset.assetId).then((snapshot) =>
			snapshot.byteLength <= MARKDOWN_LIVE_LIMIT_BYTES ? snapshot.text : undefined,
		).catch(() => {
			sourceTexts.delete(asset);
			return undefined;
		});
		sourceTexts.set(asset, pending);
	}
	return pending;
}

function readCanvas(asset: Asset): Promise<CanvasDocument | undefined> {
	let pending = canvasDocuments.get(asset);
	if (!pending) {
		pending = window.loom.readCanvas(asset.assetId).then((snapshot) => snapshot.document).catch(() => {
			canvasDocuments.delete(asset);
			return undefined;
		});
		canvasDocuments.set(asset, pending);
	}
	return pending;
}

export function embeddedReference(target: EventTarget | null): { assetId: string; anchor?: string } | null {
	const link = target instanceof Element ? target.closest<HTMLAnchorElement>(`a[${ASSET_LINK_ATTRIBUTE}], a[${ANCHOR_ATTRIBUTE}]`) : null;
	if (!link || link.classList.contains(BROKEN_REFERENCE_CLASS)) return null;
	const note = link.closest<HTMLElement>(NOTE_EMBED_SELECTOR);
	if (!note && !link.matches(EMBED_LINK_SELECTOR)) return null;
	const assetId = link.dataset.assetId || note?.dataset.noteAssetId;
	return assetId ? { assetId, anchor: link.dataset.anchor } : null;
}

/** Resolve embedded documents along each branch. Repeated documents keep their original file link. */
export async function hydrateMarkdownEmbeds(root: HTMLElement, context: MarkdownRenderContext, signal: AbortSignal, ancestors: readonly string[] = []): Promise<void> {
	if (signal.aborted) return;
	const lookup = context.lookup ?? createAssetLookup(context.assets);
	const pendingCanvases = new Map<Element, () => void>();
	const disposeCanvases = new Set<() => void>();
	let canvasObserver: IntersectionObserver | undefined;
	signal.addEventListener("abort", () => {
		canvasObserver?.disconnect();
		pendingCanvases.clear();
		for (const dispose of disposeCanvases) dispose();
	}, { once: true });

	function observeCanvas(embed: HTMLElement, load: () => void): void {
		canvasObserver ??= new IntersectionObserver((entries, observer) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				const load = pendingCanvases.get(entry.target);
				pendingCanvases.delete(entry.target);
				load?.();
			}
		});
		pendingCanvases.set(embed, load);
		canvasObserver.observe(embed);
	}

	async function expand(container: HTMLElement, trail: readonly string[]): Promise<void> {
		if (signal.aborted) return;
		if (context.interactiveHtml) observeHtmlEmbeds(container, signal);
		if (trail.length > maximumDepth) return;
		const embeds = Array.from(container.querySelectorAll<HTMLElement>(documentEmbedSelector)).filter((embed) => {
			const parent = embed.parentElement?.closest(documentEmbedSelector);
			return !parent || !container.contains(parent);
		});
		await Promise.all(embeds.map(async (embed) => {
			const canvasId = embed.dataset.canvasAssetId;
			const asset = lookup.byId(canvasId ?? embed.dataset.noteAssetId ?? "");
			if (!asset || trail.includes(asset.assetId)) return;
			const next = [...trail, asset.assetId];
			if (canvasId) {
				const content = embed.querySelector<HTMLElement>(":scope > .markdown-canvas-embed-content");
				if (!content) return;
				observeCanvas(embed, () => void readCanvas(asset).then((canvas) => {
					if (!canvas || signal.aborted || !container.contains(embed)) return;
					const dispose = mountCanvasEmbed(content, canvas, lookup);
					if (!dispose) return;
					disposeCanvases.add(dispose);
					void expand(content, next);
				}));
				return;
			}
			const content = embed.querySelector<HTMLElement>(":scope > .markdown-note-embed-content");
			if (!content || asset.size > MARKDOWN_LIVE_LIMIT_BYTES) return;
			const source = await readSource(asset);
			if (signal.aborted || !container.contains(embed)) return;
			const heading = embed.querySelector<HTMLElement>(":scope > a[data-anchor]")?.dataset.anchor;
			content.innerHTML = source === undefined ? "" : renderMarkdown(source, {
				fromRelativePath: asset.relativePath, assets: context.assets, lookup, lazyImages: true,
				interactiveHtml: context.interactiveHtml,
			}, heading);
			if (content.querySelector("pre.mermaid")) void hydrateMermaid(content);
			await expand(content, next);
		}));
	}
	const source = lookup.byPath(context.fromRelativePath);
	await expand(root, source ? [...ancestors, source.assetId] : ancestors);
}
