/** File and folder references placed in the composer and stored inline in user text. */
import type { ComposerReference, LoomAssetType, LoomUserAttachment } from "./attachments.ts";

const ASSET_TYPES = new Set<string>(["image", "video", "audio", "text", "other"]);

export function referenceKey(reference: LoomUserAttachment): string {
	return reference.type === "folder_ref" ? `folder:${reference.path}` : reference.assetId;
}

/** Library-relative path. Absolute paths, control characters and parent traversal are rejected. */
export function isRelativeLibraryPath(path: string): boolean {
	if (!path || path !== path.trim() || /[\x00-\x1f\x7f]/.test(path)) return false;
	if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
	return !path.split(/[\\/]/).includes("..");
}

export function parseComposerAssetInputs(value: unknown): ComposerReference[] {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new Error("Composer references must be a list");
	const out: ComposerReference[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "object" || item === null) throw new Error("Composer reference is invalid");
		const row = item as Record<string, unknown>;
		const path = typeof row.path === "string" ? row.path : "";
		if (!isRelativeLibraryPath(path)) throw new Error("Composer reference path must stay inside the library");
		let reference: ComposerReference;
		if (row.type === "folder_ref") {
			reference = { type: "folder_ref", path: path.replaceAll("\\", "/").replace(/\/+$/, "") };
		} else {
			if (row.type !== undefined && row.type !== "asset_ref") throw new Error("Composer reference is invalid");
			const assetId = typeof row.assetId === "string" ? row.assetId.trim() : "";
			if (!assetId) throw new Error("Composer asset is missing an asset id");
			if (typeof row.assetType !== "string" || !ASSET_TYPES.has(row.assetType)) throw new Error("Composer asset type is invalid");
			reference = { type: "asset_ref", assetId, path, assetType: row.assetType as LoomAssetType };
		}
		const key = referenceKey(reference);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(reference);
	}
	return out;
}

const REFERENCE_BLOCK = /<asset_ref>\npath: ([^\n]*)\nasset_id: ([^\n]+)\ntype: (image|video|audio|text|other)\n<\/asset_ref>|<folder_ref>\npath: ([^\n]*)\n<\/folder_ref>/g;

export type InlineAssetPart =
	| { type: "text"; text: string }
	| { type: "reference"; reference: ComposerReference };

function referenceFromMatch(match: RegExpMatchArray): ComposerReference | undefined {
	try {
		return parseComposerAssetInputs([match[4] !== undefined
			? { type: "folder_ref", path: match[4] }
			: { type: "asset_ref", path: match[1], assetId: match[2], assetType: match[3] }])[0];
	} catch { return undefined; }
}

/** Blank lines added around a reference block are not part of its chip. */
export function splitStoredAssetText(text: string): InlineAssetPart[] {
	const parts: InlineAssetPart[] = [];
	let cursor = 0;
	for (const match of text.matchAll(REFERENCE_BLOCK)) {
		const reference = referenceFromMatch(match);
		if (!reference) continue;
		const index = match.index!;
		const before = text.slice(cursor, index).replace(/\n{1,2}$/, "");
		if (before) parts.push({ type: "text", text: before });
		parts.push({ type: "reference", reference });
		cursor = index + match[0].length;
		cursor += /^\n{1,2}/.exec(text.slice(cursor))?.[0].length ?? 0;
	}
	const rest = text.slice(cursor);
	if (rest) parts.push({ type: "text", text: rest });
	return parts;
}

/** Replace valid reference blocks. Return null to leave a block unchanged. */
export function replaceAssetRefBlocks(text: string, replace: (block: ComposerReference) => string | null): string {
	return text.replace(REFERENCE_BLOCK, (...args) => {
		const reference = referenceFromMatch(args as unknown as RegExpMatchArray);
		return reference ? replace(reference) ?? args[0] : args[0];
	});
}

export function assetRefBlocks(text: string): ComposerReference[] {
	return splitStoredAssetText(text).flatMap((part) => part.type === "reference" ? [part.reference] : []);
}

/** Stored metadata refreshes references already present in the message text. */
export function displayAssetRefs(text: string, stored: readonly LoomUserAttachment[]): LoomUserAttachment[] {
	const byKey = new Map(stored.map((row) => [referenceKey(row), row]));
	const seen = new Set<string>();
	return assetRefBlocks(text).flatMap((reference) => {
		const key = referenceKey(reference);
		if (seen.has(key)) return [];
		seen.add(key);
		return [byKey.get(key) ?? reference];
	});
}

export function inlineReferenceKeys(text: string): string[] {
	return assetRefBlocks(text).map(referenceKey);
}

/** Words only, for titles and labels. */
export function stripInlineAssetRefs(text: string): string {
	return text.replace(REFERENCE_BLOCK, "");
}

/** Copilot measures this string for wrap. One space per reference chip. */
export function composerLayoutText(text: string): string {
	return splitStoredAssetText(text).map((part) => part.type === "text" ? part.text : " ").join("");
}

/** An implicit library highlight is not a placed reference. */
export function storedAssetRefs(value: unknown): ComposerReference[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!item || typeof item !== "object" || (item.type !== "asset_ref" && item.type !== "folder_ref")) return [];
		try { return parseComposerAssetInputs([item]); } catch { return []; }
	});
}
