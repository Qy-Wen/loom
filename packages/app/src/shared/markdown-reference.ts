import type { AssetType } from "@loom/core";
import { extractMarkdownReferences } from "@loom/core/references";
import { isCanvasFile } from "./canvas.ts";
import { isMarkdownFile } from "./markdown-file.ts";
import { isHtmlFile } from "./text-file.ts";

function wikiReference(path: string): string | undefined {
	const wiki = `[[${path}]]`;
	// Markdown markup and heading delimiters can make a filename ambiguous as a wiki target.
	const [reference] = extractMarkdownReferences(wiki);
	if (reference?.kind === "wiki" && reference.target === path && !/[#\\]/.test(path)) return wiki;
}

export function markdownEmbedLayout(type: AssetType, path?: string): "inline" | "block" | undefined {
	if (type === "image") return "inline";
	// These embeds use wiki syntax. Images also support standard Markdown syntax.
	if ((type === "audio" || type === "video" || (path && (isMarkdownFile(path) || isHtmlFile(path) || isCanvasFile(path)))) &&
		(path === undefined || wikiReference(path))) return "block";
}

export function markdownLibraryReference(from: string, path: string): string {
	const wiki = wikiReference(path);
	if (wiki) return wiki;

	const directory = from.split("/").slice(0, -1);
	const target = path.split("/");
	const name = target.at(-1)!.replace(/[\r\n]/g, " ").replace(/[\\\[\]`*_<>~&|]/g, "\\$&");
	let common = 0;
	while (common < directory.length && common < target.length - 1 && directory[common] === target[common]) common++;
	const address = "../".repeat(directory.length - common) + target.slice(common)
		.map((part) => encodeURIComponent(part).replaceAll("(", "%28").replaceAll(")", "%29")).join("/");
	return `[${name}](${address})`;
}
