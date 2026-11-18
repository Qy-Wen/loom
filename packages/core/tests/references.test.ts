import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Asset } from "../src/model/asset.ts";
import {
	createAssetLookup,
	extractCanvasReferences,
	extractMarkdownReferences,
	referenceSourceKind,
	resolveLibraryHref,
	resolveReferences,
} from "../src/library/references.ts";

function asset(assetId: string, relativePath: string): Asset {
	return {
		assetId,
		relativePath,
		filename: relativePath.split("/").pop() ?? relativePath,
		type: relativePath.endsWith(".md") ? "text" : "other",
		size: 1,
		createdAt: 1,
		modifiedAt: 1,
	};
}

const lookup = createAssetLookup([
	asset("script", "脚本.md"),
	asset("notes", "产品说明.md"),
	asset("deep", "产品/说明.md"),
	asset("ops", "运营/说明.md"),
	asset("diagram", "图/架构图.png"),
	asset("demo", "素材/演示.mp4"),
	asset("canvas", "分镜.canvas"),
]);

function resolveMarkdownReferences(fromPath: string, source: string, assets = lookup) {
	return resolveReferences(fromPath, extractMarkdownReferences(source), assets);
}

function resolveCanvasReferences(text: string, assets = lookup) {
	const raw = extractCanvasReferences(text);
	return raw && resolveReferences("分镜.canvas", raw, assets);
}

describe("referenceSourceKind", () => {
	it("reads only Markdown and canvas files", () => {
		assert.equal(referenceSourceKind("a/脚本.MD"), "markdown");
		assert.equal(referenceSourceKind("分镜.canvas"), "canvas");
		assert.equal(referenceSourceKind("a.txt"), undefined);
		assert.equal(referenceSourceKind("a.md.png"), undefined);
	});
});

describe("extractMarkdownReferences", () => {
	it("finds wiki links, embeds, links and images in the body", () => {
		const found = extractMarkdownReferences("[[a]] and ![[b.png]] and [c](c.md) and ![d](d.png)");
		assert.deepEqual(found.map((item) => (item.kind === "card" ? "" : item.target)), ["a", "b.png", "c.md", "d.png"]);
	});

	it("skips code, front matter and escaped text", () => {
		const source = [
			"---",
			"project: \"[[front]]\"",
			"---",
			"`[[inline]]` and \\[\\[escaped\\]\\]",
			"",
			"```",
			"[[fenced]] [x](fenced.md)",
			"```",
			"",
			"    [[indented]]",
			"",
			"[[real]]",
		].join("\n");
		assert.deepEqual(extractMarkdownReferences(source).map((item) => (item.kind === "card" ? "" : item.target)), ["real"]);
	});
});

describe("resolveMarkdownReferences", () => {
	it("resolves wiki links from the library root without searching by name", () => {
		const result = resolveMarkdownReferences("脚本.md", "[[产品说明]] [[产品/说明]] [[说明]]");
		assert.deepEqual(result.targetAssetIds, ["notes", "deep"]);
		assert.deepEqual(result.unresolved, ["说明"]);
	});

	it("drops display names and anchors", () => {
		const result = resolveMarkdownReferences("脚本.md", "[[产品说明#标题|显示]] [[产品说明#^block]]");
		assert.deepEqual(result.targetAssetIds, ["notes"]);
		assert.deepEqual(result.unresolved, []);
	});

	it("resolves embeds and images with their extension", () => {
		const result = resolveMarkdownReferences("脚本.md", "![[图/架构图.png]] ![](图/架构图.png) ![](素材/演示.mp4)");
		assert.deepEqual(result.targetAssetIds, ["diagram", "demo"]);
	});

	it("resolves Markdown links relative to the source file, with encoded Chinese paths", () => {
		const result = resolveMarkdownReferences(
			"产品/脚本.md",
			"[a](%E8%AF%B4%E6%98%8E.md) [b](../产品说明.md) [c](/运营/说明.md) [d](运营/说明.md)",
			lookup,
		);
		assert.deepEqual(result.targetAssetIds, ["deep", "notes", "ops"]);
		assert.deepEqual(result.unresolved, []);
	});

	it("merges repeated references and ignores self, external and anchor-only links", () => {
		const result = resolveMarkdownReferences(
			"脚本.md",
			"[[产品说明]] [[产品说明]] [x](产品说明.md) [[脚本]] [web](https://example.com) [mail](mailto:a@b.c) [top](#top)",
			lookup,
		);
		assert.deepEqual(result.targetAssetIds, ["notes"]);
		assert.deepEqual(result.unresolved, []);
	});

	it("reports missing targets as unresolved and does not throw on links leaving the library", () => {
		const result = resolveMarkdownReferences("脚本.md", "[[待调研]] [x](../../outside.md) [y](missing.md)");
		assert.deepEqual(result.targetAssetIds, []);
		assert.deepEqual(result.unresolved, ["待调研", "../../outside.md", "missing.md"]);
	});

	it("matches paths case-insensitively only when that is unambiguous", () => {
		const ambiguous = createAssetLookup([asset("1", "A.md"), asset("2", "a.md")]);
		assert.equal(ambiguous.byPath("A.md")?.assetId, "1");
		assert.equal(ambiguous.byPath("a.md")?.assetId, "2");
		assert.equal(ambiguous.byPath("A.MD"), undefined);
		assert.equal(lookup.byPath("产品说明.MD")?.assetId, "notes");
	});
});

describe("resolveLibraryHref", () => {
	it("keeps links inside the library", () => {
		assert.equal(resolveLibraryHref("a/b.md", "../c.md"), "c.md");
		assert.equal(resolveLibraryHref("a/b.md", "/c.md"), "c.md");
		assert.equal(resolveLibraryHref("a/b.md", "../../c.md"), undefined);
		assert.equal(resolveLibraryHref("a/b.md", ".loom/x"), undefined);
		assert.equal(resolveLibraryHref("a/b.md", "C:\\x.md"), undefined);
		assert.equal(resolveLibraryHref("a/b.md", "x\\y.md"), "a/x/y.md");
	});
});

describe("resolveCanvasReferences", () => {
	it("prefers loom.assetId and falls back to the file path", () => {
		const text = JSON.stringify({
			nodes: [
				{ id: "1", type: "file", file: "旧路径/演示.mp4", loom: { assetId: "demo" } },
				{ id: "2", type: "file", file: "素材/演示.mp4" },
				{ id: "3", type: "file", file: "图\\架构图.png" },
				{ id: "4", type: "text", text: "[[产品说明]]" },
			],
			edges: [{ id: "e", fromNode: "1", toNode: "3" }],
		});
		const result = resolveCanvasReferences(text);
		assert.deepEqual(result?.targetAssetIds, ["demo", "diagram"]);
		assert.deepEqual(result?.unresolved, []);
	});

	it("does not fall back to the path when the recorded asset is gone", () => {
		const text = JSON.stringify({
			nodes: [{ id: "1", type: "file", file: "素材/演示.mp4", loom: { assetId: "gone" } }],
			edges: [],
		});
		const result = resolveCanvasReferences(text);
		assert.deepEqual(result?.targetAssetIds, []);
		assert.deepEqual(result?.unresolved, ["素材/演示.mp4"]);
	});

	it("returns undefined for unreadable canvases", () => {
		assert.equal(resolveCanvasReferences("{"), undefined);
		assert.equal(resolveCanvasReferences("[]"), undefined);
		assert.equal(resolveCanvasReferences('{"nodes":1}'), undefined);
		assert.deepEqual(resolveCanvasReferences("{}"), { targetAssetIds: [], unresolved: [] });
	});
});

describe("wiki link matching", () => {
	it("matches a link or an embed at a position", async () => {
		const { matchWikiLink } = await import("../src/library/references.ts");
		assert.deepEqual(matchWikiLink("a [[x/y#h|别名]] b", 2), { embed: false, target: "x/y#h", label: "别名", from: 2, end: 14 });
		assert.deepEqual(matchWikiLink("![[a.png]]", 0), { embed: true, target: "a.png", label: "", from: 0, end: 10 });
		assert.equal(matchWikiLink("[[ ]]", 0), undefined);
		assert.equal(matchWikiLink("[[a\nb]]", 0), undefined);
		assert.equal(matchWikiLink("[[a]]", 1), undefined);
	});

	it("finds every link in a text, embeds included, without overlap", async () => {
		const { findWikiLinks } = await import("../src/library/references.ts");
		const text = "[[a]] 中 ![[b.png]] [[c|d]] [[[e]]] [[ ]] [[f";
		assert.deepEqual(findWikiLinks(text).map((link) => [link.embed, link.target, text.slice(link.from, link.end)]), [
			[false, "a", "[[a]]"],
			[true, "b.png", "![[b.png]]"],
			[false, "c", "[[c|d]]"],
			[false, "e", "[[e]]"],
		]);
	});
});
