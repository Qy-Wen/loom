import assert from "node:assert/strict";
import { test } from "node:test";
import type { Asset } from "@loom/core";
import { findMatchOffsets, overflowScrollDelta, preferVisibleRect } from "../src/renderer/workbench/preview/find-in-view.ts";
import { renderInlineMarkdown, renderMarkdown, resolveLibraryHref } from "../src/renderer/workbench/preview/markdown.ts";

test("findMatchOffsets is case-insensitive and non-overlapping", () => {
	assert.deepEqual(findMatchOffsets("Hello hello HELLO", "hello"), [0, 6, 12]);
	assert.deepEqual(findMatchOffsets("aaaa", "aa"), [0, 2]);
	assert.deepEqual(findMatchOffsets("abc", ""), []);
});

test("overflowScrollDelta only moves when the target is outside the padded viewport", () => {
	const viewport = { top: 100, bottom: 400, left: 0, right: 200 };
	assert.deepEqual(
		overflowScrollDelta({ top: 180, bottom: 200, left: 40, right: 80 }, viewport),
		{ top: 0, left: 0 },
	);
	assert.equal(overflowScrollDelta({ top: 80, bottom: 90, left: 10, right: 40 }, viewport).top, -44);
	assert.equal(overflowScrollDelta({ top: 500, bottom: 520, left: 10, right: 40 }, viewport).top, 144);
});

test("preferVisibleRect falls back when a range reports an empty box", () => {
	const empty = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
	const drawn = { top: 80, bottom: 96, left: 40, right: 120, width: 80, height: 16 };
	assert.equal(preferVisibleRect(empty, drawn), drawn);
	assert.equal(preferVisibleRect(drawn, empty), drawn);
});

test("renderMarkdown turns headings and lists into HTML", () => {
	const html = renderMarkdown("# Title\n\n- one\n- two");
	assert.match(html, /<h1 data-heading="title">Title<\/h1>/);
	assert.match(html, /<ul>/);
	assert.match(html, /<li>one<\/li>/);
});

test("renderMarkdown keeps inline emphasis and fenced code", () => {
	const html = renderMarkdown("Say **hi**.\n\n```js\nconst n = 1;\n```");
	assert.match(html, /<strong>hi<\/strong>/);
	assert.match(html, /<pre><code class="language-js">/);
});

test("renderMarkdown opens http links in a new tab", () => {
	const html = renderMarkdown("[docs](https://example.com)");
	assert.match(html, /href="https:\/\/example.com"/);
	assert.match(html, /target="_blank"/);
	assert.match(html, /rel="noreferrer noopener"/);
});

test("renderMarkdown does not turn javascript URLs into links", () => {
	const html = renderMarkdown("[x](javascript:alert(1))");
	assert.equal(html.includes("<a "), false);
});

test("resolveLibraryHref walks relative and rooted paths from the markdown file", () => {
	assert.equal(resolveLibraryHref("notes/a.md", "shot.png"), "notes/shot.png");
	assert.equal(resolveLibraryHref("notes/a.md", "./shot.png"), "notes/shot.png");
	assert.equal(resolveLibraryHref("notes/a.md", "../cover.jpg"), "cover.jpg");
	assert.equal(resolveLibraryHref("notes/a.md", "/cover.jpg"), "cover.jpg");
	assert.equal(resolveLibraryHref("notes/a.md", "../../outside.jpg"), undefined);
	assert.equal(resolveLibraryHref("a.md", "https://example.com/x.png"), undefined);
});

test("renderMarkdown rewrites library images onto loom-asset URLs", () => {
	const shot: Asset = {
		assetId: "shot-id",
		relativePath: "notes/shot.png",
		filename: "shot.png",
		type: "image",
		size: 12,
		createdAt: 1,
		modifiedAt: 9,
	};
	const html = renderMarkdown("![](shot.png)", {
		fromRelativePath: "notes/a.md",
		assets: [shot],
	});
	assert.match(html, /src="loom-asset:\/\/asset\/shot-id\?v=9-12"/);
});

test("renderMarkdown turns wiki image embeds into library images", () => {
	const cover: Asset = {
		assetId: "cover-id",
		relativePath: "cover.jpg",
		filename: "cover.jpg",
		type: "image",
		size: 12,
		createdAt: 1,
		modifiedAt: 4,
	};
	const context = {
		fromRelativePath: "notes/a.md",
		assets: [cover],
	};
	const html = renderMarkdown("![[cover.jpg]]", context);
	assert.match(html, /src="loom-asset:\/\/asset\/cover-id\?v=4-12"/);
	assert.match(html, /<span>cover\.jpg<\/span><\/a>/);
	assert.match(renderMarkdown("![[cover.jpg|Cover.JPG]]", context), /<span>Cover\.JPG<\/span><\/a>/);
	assert.match(renderMarkdown("![[cover.jpg|封面]]", context), /<span>封面<\/span><\/a>/);
});

test("renderMarkdown typesets TeX with KaTeX", () => {
	assert.match(renderMarkdown("The formula is $E=mc^2$."), /class="katex"/);
	assert.match(renderMarkdown("$$\\int_0^1 x\\,dx$$"), /katex-display/);
});

test("renderMarkdown leaves mermaid fences for client hydration", () => {
	const html = renderMarkdown("```mermaid\ngraph TD\n  A[\"x < y\"] --> B\n```");
	assert.match(html, /class="markdown-mermaid"/);
	assert.match(html, /<pre class="mermaid">/);
	assert.match(html, /A\[&quot;x &lt; y&quot;\] --&gt; B/);
	assert.equal(html.includes("language-mermaid"), false);
});

function libraryAsset(assetId: string, relativePath: string): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").pop() ?? relativePath,
		type: relativePath.endsWith(".png") ? "image" : "text",
		size: 5,
		createdAt: 1,
		modifiedAt: 2,
	};
}

test("renderMarkdown renders media blocks within a paragraph and compact embeds in tables", () => {
	const clip: Asset = { ...libraryAsset("clip", "clip.mp4"), type: "video" };
	const context = { fromRelativePath: "script.md", assets: [clip] };
	const video = renderMarkdown('Before![[clip.mp4|A "quoted" <title>]]After', context);
	assert.match(video, /<p>Before<span class="markdown-embed-media">.*<\/a><\/span>After<\/p>/);
	assert.match(video, /<video[^>]+poster="loom-asset:\/\/poster\/clip\?v=2-5"[^>]+aria-label="A &quot;quoted&quot; &lt;title&gt;"[^>]+preload="none"/);
	const table = renderMarkdown("| Media |\n| --- |\n| ![[clip.mp4]] |", context);
	assert.match(table, /<td><a class="markdown-embed-file markdown-file-link"[^>]+data-asset-id="clip"/);
	assert.doesNotMatch(table, /<video/);
});

test("HTML wiki embeds render in sandboxed frames and stay compact inside tables", () => {
	const context = { fromRelativePath: "note.md", assets: [libraryAsset("report", "Report.HTM")] };
	const preview = renderMarkdown('Before![[Report.HTM|A "quoted" report]]After', context);
	assert.match(preview, /<iframe class="markdown-embed-html" src="loom-asset:\/\/asset\/report\?v=2-5" title="A &quot;quoted&quot; report" sandbox=""/);
	assert.match(preview, /data-embed-link data-asset-id="report"/);
	const table = renderMarkdown("| Report |\n| --- |\n| ![[Report.HTM]] |", context);
	assert.match(table, /<td><a[^>]*data-asset-id="report"/);
	assert.doesNotMatch(table, /<iframe/);
	assert.doesNotMatch(renderMarkdown("[[Report.HTM]]", context), /<iframe/);
});

const library = [
	libraryAsset("notes", "产品说明.md"),
	libraryAsset("deep", "产品/说明.md"),
	libraryAsset("diagram", "图/架构图.png"),
];

function render(source: string, from = "脚本.md"): string {
	return renderMarkdown(source, { fromRelativePath: from, assets: library });
}

test("renderMarkdown turns wiki links into links that open the asset", () => {
	const html = render("[[产品说明.md]] [[产品/说明|别名]] [[产品说明#标题]]");
	assert.match(html, /class="markdown-file-link" data-asset-id="notes">产品说明\.md<\/a>/);
	assert.match(html, /class="markdown-file-link" data-asset-id="deep">别名<\/a>/);
	assert.equal(html.match(/data-asset-id="notes"/g)?.length, 2);
	assert.equal(html.includes("markdown-broken-reference"), false);
});

test("Markdown previews render self embeds as ordinary wiki links", () => {
	const context = { fromRelativePath: "产品/说明.md", assets: library };
	for (const target of ["产品/说明.md", "/产品/说明#标题|回到标题", "#标题"]) {
		const link = `[[${target}]]`;
		assert.equal(renderMarkdown(`!${link}`, context), renderMarkdown(link, context));
		assert.equal(renderInlineMarkdown(`!${link}`, context), renderInlineMarkdown(link, context));
	}
});

test("Markdown note embeds render sections and stay compact in table cells", () => {
	const context = { fromRelativePath: "脚本.md", assets: library };
	assert.match(renderMarkdown("![[产品/说明#标题]]", context), /data-note-asset-id="deep".*data-anchor="标题"/);
	assert.doesNotMatch(renderInlineMarkdown("![[产品/说明]]", context), /data-note-asset-id/);
	assert.doesNotMatch(renderMarkdown("![[产品/说明#^block]]", context), /data-note-asset-id/);
	const source = "# Before\n\n## **标题**\n\n```md\n## Inside code\n```\n\n### Child\n\nContent.\n\n## Next\n\nAfter.";
	const html = renderMarkdown(source, context, "标题");
	assert.match(html, /<h2 data-heading="标题"><strong>标题<\/strong><\/h2>/);
	assert.match(html, /Inside code/);
	assert.match(html, /<h3 data-heading="child">Child<\/h3>/);
	assert.doesNotMatch(html, /Before|Next|After/);
	assert.equal(renderMarkdown(source, context, "missing"), "");
});

test("renderMarkdown opens Markdown links to library files in the app", () => {
	const html = render("[a](%E4%BA%A7%E5%93%81%E8%AF%B4%E6%98%8E.md) [b](产品/说明.md) [web](https://example.com)");
	assert.match(html, /data-asset-id="notes"/);
	assert.match(html, /data-asset-id="deep"/);
	assert.match(html, /href="https:\/\/example.com" target="_blank"/);
});

test("renderMarkdown marks references to missing files as errors", () => {
	const html = render("[[待调研]] [x](missing.md) ![[missing.png]] ![](gone.png) [ok](#top)");
	assert.equal(html.match(/markdown-broken-reference/g)?.length, 4);
	assert.equal(html.includes("data-asset-id"), false);
	assert.match(html, /<a href="#" data-anchor="top">ok<\/a>/);
});

test("renderMarkdown does not treat a bare name as a library search", () => {
	const html = render("[[说明]]");
	assert.match(html, /markdown-broken-reference/);
	assert.equal(html.includes("data-asset-id"), false);
});

test("renderMarkdown leaves wiki syntax in code and escapes alone", () => {
	const html = render("`[[产品说明]]` \\[\\[产品说明\\]\\]\n\n```\n[[产品说明]]\n```");
	assert.equal(html.includes("data-asset-id"), false);
	assert.equal(html.includes("markdown-broken-reference"), false);
	assert.equal(html.includes("[[产品说明]]"), true);
});

test("renderMarkdown embeds wiki images by their full library path", () => {
	const html = render("![[图/架构图.png]]");
	assert.match(html, /src="loom-asset:\/\/asset\/diagram\?v=2-5"/);
	assert.equal(html.includes("markdown-broken-reference"), false);
});

test("renderMarkdown shows a loose snippet without a library as written", () => {
	assert.match(renderMarkdown("see [[产品说明]]"), /\[\[产品说明\]\]/);
});

test("the preview and the graph index resolve the same links to the same files", async () => {
	const { extractMarkdownReferences, resolveReferences, createAssetLookup } = await import("@loom/core/references");
	const source = "[[产品说明]] [[产品/说明]] [[说明]] ![[图/架构图.png]] [x](产品/说明.md) [y](missing.md)";
	const indexed = resolveReferences("脚本.md", extractMarkdownReferences(source), createAssetLookup(library));
	const previewed = [...render(source).matchAll(/data-asset-id="([^"]+)"|src="loom-asset:\/\/asset\/([^?"]+)/g)]
		.map((match) => match[1] ?? match[2]);
	assert.deepEqual([...new Set(previewed)].sort(), [...indexed.targetAssetIds].sort());
	assert.equal(render(source).match(/markdown-broken-reference/g)?.length, indexed.unresolved.length);
});

test("renderMarkdown tags headings and carries link anchors for in-file jumps", () => {
	const html = render("# Q&A 总结\n\n## `code` Part\n\n[[产品说明#q-a 总结]] [[产品/说明#Part|跳转]] [x](产品/说明.md#%E6%80%BB%E7%BB%93) [[#Q&A 总结]] [top](#q-a-总结) [[产品说明#^block]]");
	assert.match(html, /<h1 data-heading="q a 总结">/);
	assert.match(html, /<h2 data-heading="code part">/);
	assert.match(html, /data-asset-id="notes" data-anchor="q a 总结">产品说明 &gt; q-a 总结<small[^>]*>md<\/small><\/a>/);
	assert.match(html, /data-asset-id="deep" data-anchor="part">跳转/);
	assert.match(html, /data-asset-id="deep" data-anchor="总结"/);
	assert.match(html, /<a href="#" data-anchor="q a 总结" class="markdown-file-link">Q&amp;A 总结<\/a>/);
	assert.match(html, /<a href="#" data-anchor="q a 总结">top<\/a>/);
	// A block ID has no heading to jump to, but the link still opens the file.
	assert.match(html, /data-asset-id="notes">产品说明 &gt; \^block<small[^>]*>md<\/small><\/a><\/p>/);
	assert.equal(html.includes("markdown-broken-reference"), false);
});
