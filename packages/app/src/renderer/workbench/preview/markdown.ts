import type { Asset } from "@loom/core";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import { createAssetLookup, matchWikiLink, resolveLibraryHref, resolveLinkTarget, resolveWikiTarget, type AssetLookup } from "@loom/core/references";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { anchorOf, headingKey } from "./heading-key.ts";
import { KATEX_OPTIONS, MATH_DELIMITERS } from "./math.ts";

export { resolveLibraryHref };
export { headingKey } from "./heading-key.ts";

export interface MarkdownRenderContext {
	fromRelativePath: string;
	assets: Asset[];
	lazyImages?: boolean;
	/** Built from `assets` when absent. Pass one to share it across renders of the same library. */
	lookup?: AssetLookup;
}

/** Marks a reference whose target is not in the library. */
export const BROKEN_REFERENCE_CLASS = "markdown-broken-reference";
/** Carries the asset ID of a link to another library file, for the click handler. */
export const ASSET_LINK_ATTRIBUTE = "data-asset-id";

/** Set on a heading: its text reduced by {@link headingKey}, which a link anchor is matched against. */
export const HEADING_ATTRIBUTE = "data-heading";
/** Set on a link: the heading it points to, reduced by {@link headingKey}. */
export const ANCHOR_ATTRIBUTE = "data-anchor";

function lookupOf(context: MarkdownRenderContext): AssetLookup {
	context.lookup ??= createAssetLookup(context.assets);
	return context.lookup;
}

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.use(texmath, {
	engine: katex,
	delimiters: MATH_DELIMITERS,
	katexOptions: { ...KATEX_OPTIONS },
});

const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => {
	return self.renderToken(tokens, idx, options);
});
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const href = String(token.attrGet("href") ?? "");
	const context = env as MarkdownRenderContext | undefined;
	if (token.meta?.wiki) {
		// Already resolved by the wiki_link rule.
	} else if (/^(javascript|data|vbscript):/i.test(href.trim())) {
		token.attrSet("href", "#");
	} else if (context?.fromRelativePath && href.startsWith("#") && href.length > 1) {
		// A heading in this same file.
		const anchor = anchorOf(href.slice(1));
		token.attrSet("href", "#");
		if (anchor) token.attrSet(ANCHOR_ATTRIBUTE, anchor);
	} else if (context?.fromRelativePath && !isPassthroughHref(href)) {
		markInternalLink(token, resolveLinkTarget(context.fromRelativePath, href, lookupOf(context)), href);
	} else {
		token.attrSet("target", "_blank");
		token.attrSet("rel", "noreferrer noopener");
	}
	return defaultLinkOpen(tokens, idx, options, env, self);
};

/** A link to a library file opens that file in the app. A link to a missing one is flagged, not followed. */
function markInternalLink(token: { attrSet(name: string, value: string): void }, target: Asset | undefined | null, written: string): void {
	if (target === null) {
		token.attrSet("target", "_blank");
		token.attrSet("rel", "noreferrer noopener");
		return;
	}
	token.attrSet("href", "#");
	if (!target) {
		token.attrSet("class", BROKEN_REFERENCE_CLASS);
		return;
	}
	token.attrSet(ASSET_LINK_ATTRIBUTE, target.assetId);
	const hash = written.indexOf("#");
	const anchor = hash === -1 ? undefined : anchorOf(written.slice(hash + 1));
	if (anchor) token.attrSet(ANCHOR_ATTRIBUTE, anchor);
}

const defaultHeadingOpen = markdown.renderer.rules.heading_open ?? ((tokens, idx, options, _env, self) => {
	return self.renderToken(tokens, idx, options);
});
markdown.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
	const text = (tokens[idx + 1]?.children ?? [])
		.filter((child) => child.type === "text" || child.type === "code_inline")
		.map((child) => child.content)
		.join("");
	tokens[idx].attrSet(HEADING_ATTRIBUTE, headingKey(text));
	return defaultHeadingOpen(tokens, idx, options, env, self);
};

const defaultFence = markdown.renderer.rules.fence ?? ((tokens, idx, options, _env, self) => {
	return self.renderToken(tokens, idx, options);
});
markdown.renderer.rules.fence = (tokens, idx, options, env, self) => {
	const lang = String(tokens[idx].info ?? "").trim().split(/\s+/)[0]?.toLowerCase();
	if (lang === "mermaid") {
		return `<div class="markdown-mermaid"><pre class="mermaid">${markdown.utils.escapeHtml(tokens[idx].content)}</pre></div>\n`;
	}
	return defaultFence(tokens, idx, options, env, self);
};

const defaultImage = markdown.renderer.rules.image ?? ((tokens, idx, options, _env, self) => {
	return self.renderToken(tokens, idx, options);
});
markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const src = String(token.attrGet("src") ?? "");
	const context = env as MarkdownRenderContext | undefined;
	if (context?.lazyImages) token.attrSet("loading", "lazy");
	if (token.meta?.wiki) {
		// Already resolved by the wiki_link rule.
	} else if (src && /^(javascript|vbscript|data):/i.test(src.trim())) {
		token.attrSet("src", "");
	} else if (context && src && !isPassthroughHref(src)) {
		const asset = assetForHref(context, src);
		if (asset) token.attrSet("src", assetPreviewUrl(asset));
		else if (context.fromRelativePath && resolveLinkTarget(context.fromRelativePath, src, lookupOf(context)) === undefined) {
			token.attrSet("class", BROKEN_REFERENCE_CLASS);
		}
	}
	return defaultImage(tokens, idx, options, env, self);
};

export function isPassthroughHref(href: string): boolean {
	return /^(https?:|loom-asset:|mailto:|blob:|#)/i.test(href.trim());
}

function assetForHref(context: MarkdownRenderContext, src: string): Asset | undefined {
	const target = resolveLinkTarget(context.fromRelativePath, src, lookupOf(context));
	return target ?? undefined;
}

/**
 * `[[target]]` and `![[target]]` as an inline rule, so code spans, code blocks and escaped text are left alone.
 * An embed becomes an image token and a link becomes a link, then both render like their Markdown forms.
 */
markdown.inline.ruler.before("link", "wiki_link", (state, silent) => {
	const { src, pos } = state;
	const found = matchWikiLink(src, pos);
	if (!found) return false;
	if (silent) return true;

	const { embed, target: written, label } = found;
	const close = found.end - 2;
	const context = state.env as unknown as MarkdownRenderContext | undefined;
	const hash = written.indexOf("#");
	const anchor = hash === -1 ? undefined : anchorOf(written.slice(hash + 1));
	// Without a library (a loose snippet) nothing can be resolved, so nothing is flagged either.
	const asset = context?.assets ? resolveWikiTarget(written, lookupOf(context)) : null;
	if (!embed && context?.assets && anchor && !written.slice(0, hash).trim()) {
		// `[[#Heading]]`: a heading in this same file.
		const link = state.push("link_open", "a", 1);
		link.attrs = [["href", "#"], [ANCHOR_ATTRIBUTE, anchor]];
		link.meta = { wiki: true };
		state.push("text", "", 0).content = label || written.slice(hash + 1).split("#").pop() || written;
		state.push("link_close", "a", -1);
		state.pos = close + 2;
		return true;
	}
	if (asset === null) {
		const text = state.push("text", "", 0);
		text.content = src.slice(pos, close + 2);
		state.pos = close + 2;
		return true;
	}
	if (embed) {
		const image = state.push("image", "img", 0);
		image.attrs = [["src", asset ? assetPreviewUrl(asset) : ""], ["alt", label || written]];
		image.children = [];
		image.content = label || written;
		image.meta = { wiki: true };
		if (!asset) image.attrSet("class", BROKEN_REFERENCE_CLASS);
		else if (context?.lazyImages) image.attrSet("loading", "lazy");
	} else {
		const link = state.push("link_open", "a", 1);
		link.attrs = [["href", "#"]];
		if (asset) link.attrSet(ASSET_LINK_ATTRIBUTE, asset.assetId);
		else link.attrSet("class", BROKEN_REFERENCE_CLASS);
		if (asset && anchor) link.attrSet(ANCHOR_ATTRIBUTE, anchor);
		link.meta = { wiki: true };
		state.push("text", "", 0).content = label || written.replaceAll("#", " > ");
		state.push("link_close", "a", -1);
	}
	state.pos = close + 2;
	return true;
});

export function renderMarkdown(source: string, context?: MarkdownRenderContext): string {
	return markdown.render(source, context as never);
}
