import MarkdownIt from "markdown-it";
import type { Asset } from "../model/asset.ts";
import type { ReferenceSource } from "../model/relation.ts";

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

const WIKI_LINK = /!?\[\[([^[\]\n]+?)\]\]/y;
const FRONT_MATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const EXTERNAL_SCHEME = /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i;

/** A wiki link or embed found in text. `from` and `end` are offsets into that text. */
export interface WikiLinkMatch {
	embed: boolean;
	/** The path and optional `#heading`, as written and trimmed. */
	target: string;
	/** The `|display name`, or an empty string. */
	label: string;
	from: number;
	end: number;
}

/**
 * The wiki link or embed that starts exactly at `position`, or `undefined`. The one place that says what
 * counts as one, so the preview, the reference scan and the editor agree. It does not know about code or
 * escapes: the caller only asks at positions where Markdown allows inline syntax.
 */
export function matchWikiLink(text: string, position: number): WikiLinkMatch | undefined {
	WIKI_LINK.lastIndex = position;
	const match = WIKI_LINK.exec(text);
	if (!match || !match[1].trim()) return undefined;
	const [target, ...rest] = match[1].split("|");
	return {
		embed: match[0].startsWith("!"),
		target: target.trim(),
		label: rest.join("|").trim(),
		from: position,
		end: position + match[0].length,
	};
}

/** Every wiki link in a piece of text. Used on text that is already known to be outside code. */
export function findWikiLinks(text: string): WikiLinkMatch[] {
	const found: WikiLinkMatch[] = [];
	for (let at = text.indexOf("[["); at !== -1; at = text.indexOf("[[", at + 1)) {
		const from = at > 0 && text[at - 1] === "!" ? at - 1 : at;
		const match = matchWikiLink(text, from);
		if (!match) continue;
		found.push(match);
		at = match.end - 1;
	}
	return found;
}

/** A reference as written in a source file, before it is matched to an asset. */
export type RawReference =
	| { kind: "wiki" | "link"; target: string }
	| { kind: "card"; assetId: string; path: string };

/** Files whose contents are read for references. */
export function referenceSourceKind(relativePath: string): ReferenceSource | undefined {
	if (/\.md$/i.test(relativePath)) return "markdown";
	if (/\.canvas$/i.test(relativePath)) return "canvas";
	return undefined;
}

/**
 * Wiki links, embeds, Markdown links and images in the body of a Markdown file.
 * Code, front matter and escaped text are skipped, so examples in code never become references.
 */
export function extractMarkdownReferences(source: string): RawReference[] {
	const body = source.replace(FRONT_MATTER, "");
	const found: RawReference[] = [];
	for (const block of markdown.parse(body, {})) {
		for (const token of block.children ?? []) {
			if (token.type === "link_open") found.push({ kind: "link", target: String(token.attrGet("href") ?? "") });
			else if (token.type === "image") found.push({ kind: "link", target: String(token.attrGet("src") ?? "") });
			else if (token.type === "text") {
				for (const match of findWikiLinks(token.content)) found.push({ kind: "wiki", target: match.target });
			}
		}
	}
	return found;
}

/**
 * File cards of a `.canvas` document. Returns `undefined` when the text is not a readable canvas,
 * so the caller keeps the previous result instead of clearing it.
 */
export function extractCanvasReferences(text: string): RawReference[] | undefined {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) return undefined;
	const nodes = (document as { nodes?: unknown }).nodes;
	if (nodes !== undefined && !Array.isArray(nodes)) return undefined;
	const found: RawReference[] = [];
	for (const node of nodes ?? []) {
		if (typeof node !== "object" || node === null || (node as { type?: unknown }).type !== "file") continue;
		const { file, loom } = node as { file?: unknown; loom?: { assetId?: unknown } | null };
		const assetId = typeof loom?.assetId === "string" ? loom.assetId.trim() : "";
		const path = typeof file === "string" ? file.trim().replaceAll("\\", "/") : "";
		if (assetId || path) found.push({ kind: "card", assetId, path });
	}
	return found;
}

/**
 * Match references to assets. `fromPath` is the source file's library-relative path, using `/`.
 * A canvas card with `loom.assetId` resolves by that ID only, so a missing asset stays unresolved
 * instead of silently matching another file at the same path.
 */
export function resolveReferences(fromPath: string, references: readonly RawReference[], lookup: AssetLookup): ResolvedReferences {
	const result: ResolvedReferences = { targetAssetIds: [], unresolved: [] };
	for (const reference of references) {
		let written: string;
		let asset: Asset | undefined | null;
		if (reference.kind === "card") {
			written = reference.path || reference.assetId;
			asset = reference.assetId ? lookup.byId(reference.assetId) : lookup.byPath(reference.path);
		} else {
			written = reference.target.trim();
			asset = reference.kind === "wiki"
				? resolveWikiTarget(written, lookup)
				: resolveLinkTarget(fromPath, written, lookup);
		}
		if (asset === null) continue;
		if (asset === undefined) addUnresolved(result, written);
		else if (asset.relativePath !== fromPath) addTarget(result, asset.assetId);
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

/**
 * Wiki target: directories start from the library root. Anchors and display names are dropped.
 * `null` means the text is not a reference; `undefined` means it is one but no asset matches.
 */
export function resolveWikiTarget(written: string, lookup: AssetLookup): Asset | undefined | null {
	const target = written.split("|")[0].split("#")[0].trim().replaceAll("\\", "/");
	if (!target) return null;
	const path = joinLibraryPath([], target);
	if (!path) return undefined;
	return lookup.byPath(path) ?? (/\.md$/i.test(path) ? undefined : lookup.byPath(`${path}.md`));
}

/** Markdown link or image address, with the same `null` / `undefined` meaning as {@link resolveWikiTarget}. */
export function resolveLinkTarget(fromFile: string, written: string, lookup: AssetLookup): Asset | undefined | null {
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

function addTarget(result: ResolvedReferences, assetId: string): void {
	if (!result.targetAssetIds.includes(assetId)) result.targetAssetIds.push(assetId);
}

function addUnresolved(result: ResolvedReferences, written: string): void {
	if (written && !result.unresolved.includes(written)) result.unresolved.push(written);
}
