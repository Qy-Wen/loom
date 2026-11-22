import type { Asset } from "@loom/core";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import { createAssetLookup, matchWikiLink, resolveLibraryHref, resolveLinkTarget, resolveWikiTarget, type AssetLookup, type WikiLinkMatch } from "@loom/core/references";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";
import { anchorOf, headingKey } from "./heading-key.ts";
import { fileExtensionLabel, FILE_LINK_CLASS, renderAssetEmbed, renderFileExtension } from "./embed-renderers.ts";
import { KATEX_OPTIONS, MATH_DELIMITERS } from "./math.ts";

export { resolveLibraryHref };
export { headingKey } from "./heading-key.ts";

export interface MarkdownRenderContext {
	fromRelativePath: string;
	assets: readonly Asset[];
	lazyImages?: boolean;
	compactEmbeds?: boolean;
	interactiveHtml?: boolean;
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
type MarkdownToken = ReturnType<typeof markdown.parse>[number];

function headingTokenKey(inline: MarkdownToken | undefined): string {
	const text = (inline?.children ?? [])
		.filter((child) => child.type === "text" || child.type === "code_inline")
		.map((child) => child.content)
		.join("");
	return headingKey(text);
}

markdown.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
	tokens[idx].attrSet(HEADING_ATTRIBUTE, headingTokenKey(tokens[idx + 1]));
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
 * Both the editor and HTML preview use the same file embed renderers.
 */
interface WikiEmbedToken {
	asset: Asset;
	reference: WikiLinkMatch;
	anchor?: string;
	compact?: boolean;
}

markdown.renderer.rules.wiki_embed = (tokens, idx, _options, env) => {
	const context = env as MarkdownRenderContext | undefined;
	const { asset, reference, anchor, compact } = tokens[idx].meta?.embed as WikiEmbedToken;
	const html = renderAssetEmbed(asset, reference, anchor, {
		compact: compact || context?.compactEmbeds,
		interactiveHtml: context?.interactiveHtml,
	});
	return context?.compactEmbeds ? `<span class="markdown-cell-embed" data-source-from="${reference.from}" contenteditable="false">${html}</span>` : html;
};
markdown.renderer.rules.wiki_file_extension = (tokens, idx) => renderFileExtension(tokens[idx].content);

markdown.core.ruler.after("inline", "compact_table_embeds", ({ tokens }) => {
	for (let index = 1; index < tokens.length; index++) {
		const previous = tokens[index - 1].type;
		if (previous !== "td_open" && previous !== "th_open") continue;
		for (const child of tokens[index].children ?? []) {
			if (child.type === "wiki_embed" && child.meta) (child.meta.embed as WikiEmbedToken).compact = true;
		}
	}
});
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
	if (context?.assets && anchor && hash === 0) {
		// `[[#Heading]]`: a heading in this same file.
		const link = state.push("link_open", "a", 1);
		link.attrs = [["href", "#"], [ANCHOR_ATTRIBUTE, anchor]];
		link.attrSet("class", FILE_LINK_CLASS);
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
	if (embed && asset?.relativePath !== context?.fromRelativePath) {
		if (asset) {
			const token = state.push("wiki_embed", "", 0);
			token.meta = { embed: { asset, reference: found, anchor } satisfies WikiEmbedToken };
		} else {
			state.push("span_open", "span", 1).attrSet("class", BROKEN_REFERENCE_CLASS);
			state.push("text", "", 0).content = src.slice(pos, found.end);
			state.push("span_close", "span", -1);
		}
	} else {
		const link = state.push("link_open", "a", 1);
		link.attrs = [["href", "#"]];
		link.attrSet("class", asset ? FILE_LINK_CLASS : BROKEN_REFERENCE_CLASS);
		if (asset) link.attrSet(ASSET_LINK_ATTRIBUTE, asset.assetId);
		if (asset && anchor) link.attrSet(ANCHOR_ATTRIBUTE, anchor);
		link.meta = { wiki: true };
		state.push("text", "", 0).content = label || written.replaceAll("#", " > ");
		const extension = asset && fileExtensionLabel(asset, found);
		if (extension) state.push("wiki_file_extension", "", 0).content = extension;
		state.push("link_close", "a", -1);
	}
	state.pos = close + 2;
	return true;
});

export function renderMarkdown(source: string, context?: MarkdownRenderContext, heading?: string): string {
	if (!heading) return markdown.render(source, context as never);
	const env = context ?? {};
	const tokens = markdown.parse(source, env);
	const isHeading = (token: MarkdownToken) => token.type === "heading_open" && token.level === 0;
	const start = tokens.findIndex((token, index) => isHeading(token) && headingTokenKey(tokens[index + 1]) === heading);
	if (start === -1) return "";
	const end = tokens.findIndex((token, index) => index > start && isHeading(token) && token.tag <= tokens[start].tag);
	return markdown.renderer.render(tokens.slice(start, end === -1 ? undefined : end), markdown.options, env);
}

/** The visible text of an inline Markdown heading, using exactly the HTML heading renderer's rule. */
export function markdownHeadingKey(source: string): string {
	return headingTokenKey(markdown.parseInline(source, {})[0]);
}

/** One line of Markdown without the paragraph around it: the content of a table cell. */
export function renderInlineMarkdown(source: string, context?: MarkdownRenderContext): string {
	return markdown.renderInline(source, context ? { ...context, compactEmbeds: true } : {});
}
