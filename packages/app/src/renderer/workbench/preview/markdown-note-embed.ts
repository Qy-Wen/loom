import type { Asset } from "@loom/core";
import { createAssetLookup } from "@loom/core/references";
import { MARKDOWN_LIVE_LIMIT_BYTES } from "../../../shared/markdown-file.ts";
import { EMBED_LINK_SELECTOR, NOTE_EMBED_SELECTOR } from "./embed-renderers.ts";
import { ASSET_LINK_ATTRIBUTE, ANCHOR_ATTRIBUTE, BROKEN_REFERENCE_CLASS, renderMarkdown, type MarkdownRenderContext } from "./markdown.ts";
import { hydrateMermaid } from "./mermaid.ts";

const sourceTexts = new WeakMap<Asset, Promise<string | undefined>>();
const maximumDepth = 6;

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

export function embeddedReference(target: EventTarget | null): { assetId: string; anchor?: string } | null {
	const link = target instanceof Element ? target.closest<HTMLAnchorElement>(`a[${ASSET_LINK_ATTRIBUTE}], a[${ANCHOR_ATTRIBUTE}]`) : null;
	if (!link || link.classList.contains(BROKEN_REFERENCE_CLASS)) return null;
	const note = link.closest<HTMLElement>(NOTE_EMBED_SELECTOR);
	if (!note && !link.matches(EMBED_LINK_SELECTOR)) return null;
	const assetId = link.dataset.assetId || note?.dataset.noteAssetId;
	return assetId ? { assetId, anchor: link.dataset.anchor } : null;
}

/** Resolve each note in its own directory. Keep the file link when a preview cannot be expanded. */
export async function hydrateMarkdownNoteEmbeds(root: HTMLElement, context: MarkdownRenderContext, signal: AbortSignal): Promise<void> {
	const lookup = context.lookup ?? createAssetLookup(context.assets);
	async function expand(container: HTMLElement, trail: readonly string[]): Promise<void> {
		if (signal.aborted || trail.length > maximumDepth) return;
		const notes = Array.from(container.querySelectorAll<HTMLElement>(NOTE_EMBED_SELECTOR)).filter((note) => {
			const parent = note.parentElement?.closest(NOTE_EMBED_SELECTOR);
			return !parent || !container.contains(parent);
		});
		await Promise.all(notes.map(async (note) => {
			const asset = lookup.byId(note.dataset.noteAssetId ?? "");
			const content = note.querySelector<HTMLElement>(":scope > .markdown-note-embed-content");
			if (!content || !asset || asset.size > MARKDOWN_LIVE_LIMIT_BYTES || trail.includes(asset.relativePath)) return;
			const source = await readSource(asset);
			if (signal.aborted || !container.contains(note)) return;
			const heading = note.querySelector<HTMLElement>(":scope > a[data-anchor]")?.dataset.anchor;
			content.innerHTML = source === undefined ? "" : renderMarkdown(source, {
				fromRelativePath: asset.relativePath, assets: context.assets, lookup, lazyImages: true,
			}, heading);
			if (content.querySelector("pre.mermaid")) void hydrateMermaid(content);
			await expand(content, [...trail, asset.relativePath]);
		}));
	}
	await expand(root, [context.fromRelativePath]);
}
