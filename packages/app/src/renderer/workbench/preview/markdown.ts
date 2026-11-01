import type { Asset } from "@loom/core";
import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import { assetPreviewUrl } from "../../assets/asset-utils.ts";

export interface MarkdownRenderContext {
	fromRelativePath: string;
	assets: Asset[];
}

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.use(texmath, {
	engine: katex,
	delimiters: ["dollars", "brackets"],
	katexOptions: { throwOnError: false },
});

const defaultLinkOpen = markdown.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => {
	return self.renderToken(tokens, idx, options);
});
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const href = String(tokens[idx].attrGet("href") ?? "");
	if (/^(javascript|data|vbscript):/i.test(href.trim())) {
		tokens[idx].attrSet("href", "#");
	} else {
		tokens[idx].attrSet("target", "_blank");
		tokens[idx].attrSet("rel", "noreferrer noopener");
	}
	return defaultLinkOpen(tokens, idx, options, env, self);
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
	if (src && /^(javascript|vbscript|data):/i.test(src.trim())) {
		token.attrSet("src", "");
	} else if (context && src && !isPassthroughHref(src)) {
		const asset = assetForHref(context, src);
		if (asset) token.attrSet("src", assetPreviewUrl(asset));
	}
	return defaultImage(tokens, idx, options, env, self);
};

export function isPassthroughHref(href: string): boolean {
	return /^(https?:|loom-asset:|mailto:|blob:|#)/i.test(href.trim());
}

function parentOf(relativePath: string): string {
	const index = relativePath.lastIndexOf("/");
	return index === -1 ? "" : relativePath.slice(0, index);
}

/** Resolve a markdown href to a library-relative POSIX path, or `undefined` if it leaves the library. */
export function resolveLibraryHref(fromFile: string, href: string): string | undefined {
	const trimmed = href.trim().replaceAll("\\", "/");
	if (!trimmed || isPassthroughHref(trimmed)) return undefined;
	const pathOnly = trimmed.split(/[?#]/)[0];
	let decoded = pathOnly;
	try {
		decoded = decodeURIComponent(pathOnly);
	} catch {
		return undefined;
	}
	const rooted = decoded.startsWith("/");
	const rest = decoded.replace(/^\/+/, "");
	const parts = rooted ? [] : parentOf(fromFile).split("/").filter(Boolean);
	for (const part of rest.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return undefined;
			parts.pop();
			continue;
		}
		if (part === ".loom" || part.includes("\0")) return undefined;
		parts.push(part);
	}
	return parts.join("/") || undefined;
}

function assetForHref(context: MarkdownRenderContext, src: string): Asset | undefined {
	const relative = resolveLibraryHref(context.fromRelativePath, src);
	const rooted = src.startsWith("/") || src.startsWith(".")
		? undefined
		: resolveLibraryHref(context.fromRelativePath, `/${src}`);
	for (const path of [relative, rooted]) {
		if (!path) continue;
		const asset = context.assets.find((item) => item.relativePath === path);
		if (asset) return asset;
	}
}

function expandWikiImages(source: string): string {
	return source.replace(/!\[\[([^\]|#\n]+)(?:\|[^\]]*)?\]\]/g, (match, path: string) => {
		const target = String(path).trim().replaceAll("\\", "/");
		if (!target) return match;
		const href = target.startsWith("/") || target.startsWith(".") ? target : `/${target}`;
		return `![](${href})`;
	});
}

export function renderMarkdown(source: string, context?: MarkdownRenderContext): string {
	return markdown.render(expandWikiImages(source), context as never);
}
