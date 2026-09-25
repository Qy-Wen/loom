import assert from "node:assert/strict";
import { test } from "node:test";
import type { Asset } from "@loom/core";
import { findMatchOffsets, overflowScrollDelta } from "../src/renderer/workbench/find-in-view.ts";
import { renderMarkdown, resolveLibraryHref } from "../src/renderer/workbench/markdown.ts";

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

test("renderMarkdown turns headings and lists into HTML", () => {
	const html = renderMarkdown("# Title\n\n- one\n- two");
	assert.match(html, /<h1>Title<\/h1>/);
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
	assert.match(html, /src="loom-asset:\/\/asset\/shot-id\?v=9"/);
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
	const html = renderMarkdown("![[cover.jpg]]", {
		fromRelativePath: "notes/a.md",
		assets: [cover],
	});
	assert.match(html, /src="loom-asset:\/\/asset\/cover-id\?v=4"/);
});

test("renderMarkdown typesets TeX with KaTeX", () => {
	assert.match(renderMarkdown("The formula is $E=mc^2$."), /class="katex"/);
	assert.match(renderMarkdown("$$\\int_0^1 x\\,dx$$"), /katex-display/);
});
