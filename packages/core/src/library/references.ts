import MarkdownIt from "markdown-it";
import type { Asset } from "../model/asset.ts";

/** Finds assets by ID or library-relative path. Built once per scan from the asset list. */
export interface AssetLookup {
	byId(assetId: string): Asset | undefined;
	/** Exact path first; otherwise a case-insensitive match when exactly one asset matches. */
	byPath(relativePath: string): Asset | undefined;
}

export function createAssetLookup(assets: readonly Asset[]): AssetLookup {
	const ids = new Map<string, Asset>();
	const paths = new Map<string, Asset>();
	const folded = new Map<string, Asset[]>();
	for (const asset of assets) {
		ids.set(asset.assetId, asset);
		paths.set(asset.relativePath, asset);
		const key = asset.relativePath.toLowerCase();
		folded.set(key, [...(folded.get(key) ?? []), asset]);
	}
	return {
		byId: (assetId) => ids.get(assetId),
		byPath(relativePath) {
			const exact = paths.get(relativePath);
			if (exact) return exact;
			const candidates = folded.get(relativePath.toLowerCase());
			return candidates?.length === 1 ? candidates[0] : undefined;
		},
	};
}

/** What one source file references. `unresolved` keeps the text as written, for marking reference errors. */
export interface ResolvedReferences {
	/** Unique target asset IDs, in first-seen order. The source file itself is never included. */
	targetAssetIds: string[];
	unresolved: string[];
}

const markdown = new MarkdownIt({ html: false, linkify: false });
// Keep escaped characters as separate tokens so `\[\[x\]\]` is not mistaken for a wiki link.
markdown.disable("text_join");

const WIKI_LINK = /!?\[\[([^[\]\n]+?)\]\]/g;
const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const EXTERNAL_SCHEME = /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i;

interface RawMarkdownReference {
	kind: "wiki" | "link";
	target: string;
}

/**
 * Wiki links, embeds, Markdown links and images in the body of a Markdown file.
 * Code, front matter and escaped text are skipped, so examples in code never become references.
 */
export function extractMarkdownReferences(source: string): RawMarkdownReference[] {
	const body = source.replace(FRONT_MATTER, "");
	const found: RawMarkdownReference[] = [];
	for (const block of markdown.parse(body, {})) {
		for (const token of block.children ?? []) {
			if (token.type === "link_open") found.push({ kind: "link", target: String(token.attrGet("href") ?? "") });
			else if (token.type === "image") found.push({ kind: "link", target: String(token.attrGet("src") ?? "") });
			else if (token.type === "text") {
				for (const match of token.content.matchAll(WIKI_LINK)) found.push({ kind: "wiki", target: match[1] });
			}
		}
	}
	return found;
}

/** Resolve the references of one Markdown file. `fromPath` is library-relative and uses `/`. */
export function resolveMarkdownReferences(fromPath: string, source: string, lookup: AssetLookup): ResolvedReferences {
	const result = newResult();
	for (const reference of extractMarkdownReferences(source)) {
		const written = reference.target.trim();
		const asset = reference.kind === "wiki"
			? resolveWikiTarget(written, lookup)
			: resolveLinkTarget(fromPath, written, lookup);
		if (asset === null) continue;
		if (asset === undefined) addUnresolved(result, written);
		else if (asset.relativePath !== fromPath) addTarget(result, asset.assetId);
	}
	return result;
}

/**
 * Resolve the file cards of a `.canvas` document. A card with `loom.assetId` resolves by that ID only,
 * so a missing asset stays unresolved instead of silently matching another file at the same path.
 * Returns `undefined` when the text is not a readable canvas, so the caller keeps the previous result.
 */
export function resolveCanvasReferences(text: string, lookup: AssetLookup): ResolvedReferences | undefined {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
	const nodes = (document as { nodes?: unknown }).nodes;
	if (nodes !== undefined && !Array.isArray(nodes)) return undefined;
	const result = newResult();
	for (const node of nodes ?? []) {
		if (typeof node !== "object" || node === null || (node as { type?: unknown }).type !== "file") continue;
		const { file, loom } = node as { file?: unknown; loom?: { assetId?: unknown } | null };
		const assetId = typeof loom?.assetId === "string" ? loom.assetId.trim() : "";
		const path = typeof file === "string" ? file.trim().replaceAll("\\", "/") : "";
		const asset = assetId ? lookup.byId(assetId) : path ? lookup.byPath(path) : undefined;
		if (asset) addTarget(result, asset.assetId);
		else if (assetId || path) addUnresolved(result, path || assetId);
	}
	return result;
}

/**
 * Resolve a Markdown link or image address to a library-relative path, or `undefined` if it is empty,
 * external, or leaves the library. Relative addresses start from the source file's directory;
 * a leading `/` starts from the library root.
 */
export function resolveLibraryHref(fromFile: string, href: string): string | undefined {
	const trimmed = href.trim().replaceAll("\\", "/");
	if (!trimmed || trimmed.startsWith("#") || EXTERNAL_SCHEME.test(trimmed) || /^[a-z]:/i.test(trimmed)) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(trimmed.split(/[?#]/)[0]);
	} catch {
		return undefined;
	}
	return joinLibraryPath(decoded.startsWith("/") ? [] : parentOf(fromFile), decoded);
}

/** Wiki target: directories start from the library root. Anchors and display names are dropped. */
function resolveWikiTarget(written: string, lookup: AssetLookup): Asset | undefined | null {
	const target = written.split("|")[0].split("#")[0].trim().replaceAll("\\", "/");
	if (!target) return null;
	const path = joinLibraryPath([], target);
	if (!path) return undefined;
	return lookup.byPath(path) ?? (/\.md$/i.test(path) ? undefined : lookup.byPath(`${path}.md`));
}

function resolveLinkTarget(fromFile: string, written: string, lookup: AssetLookup): Asset | undefined | null {
	if (!written || written.startsWith("#") || EXTERNAL_SCHEME.test(written)) return null;
	const relative = resolveLibraryHref(fromFile, written);
	// Match the preview: an address that is neither `/`- nor `.`-prefixed may also start at the library root.
	const rooted = /^[/.]/.test(written) ? undefined : resolveLibraryHref("", `/${written}`);
	for (const path of [relative, rooted]) {
		const asset = path ? lookup.byPath(path) : undefined;
		if (asset) return asset;
	}
	return undefined;
}

function joinLibraryPath(base: string[], relative: string): string | undefined {
	const parts = [...base];
	for (const part of relative.split("/")) {
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

function parentOf(relativePath: string): string[] {
	const parts = relativePath.split("/").filter(Boolean);
	parts.pop();
	return parts;
}

function newResult(): ResolvedReferences {
	return { targetAssetIds: [], unresolved: [] };
}

function addTarget(result: ResolvedReferences, assetId: string): void {
	if (!result.targetAssetIds.includes(assetId)) result.targetAssetIds.push(assetId);
}

function addUnresolved(result: ResolvedReferences, written: string): void {
	if (written && !result.unresolved.includes(written)) result.unresolved.push(written);
}
