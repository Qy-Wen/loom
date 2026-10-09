/** Composer chips: library assets the user placed in the next message. They are stored as `<asset_ref>` blocks in the text. */

import { type AssetRefAttachment, type LoomAssetType, type LoomUserAttachment } from "./attachments.ts";

const ASSET_TYPES = new Set<string>(["image", "video", "audio", "text", "other"]);

/** Library-relative path. Absolute paths and `..` segments are rejected. */
export function isRelativeLibraryPath(path: string): boolean {
	if (!path || path !== path.trim()) return false;
	if (path.startsWith("/") || path.startsWith("\\")) return false;
	if (/^[A-Za-z]:[\\/]/.test(path)) return false;
	if (path.split(/[\\/]/).includes("..")) return false;
	return true;
}

export function parseComposerAssetInputs(value: unknown): AssetRefAttachment[] {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new Error("Composer assets must be a list");
	const out: AssetRefAttachment[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "object" || item === null) throw new Error("Composer asset is invalid");
		const row = item as Record<string, unknown>;
		const assetId = typeof row.assetId === "string" ? row.assetId.trim() : "";
		const path = typeof row.path === "string" ? row.path : "";
		const assetType = row.assetType;
		if (row.type === "ui_selection") throw new Error("Composer asset is invalid");
		if (!assetId) throw new Error("Composer asset is missing an asset id");
		if (!isRelativeLibraryPath(path)) throw new Error("Composer asset path must stay inside the library");
		if (typeof assetType !== "string" || !ASSET_TYPES.has(assetType)) throw new Error("Composer asset type is invalid");
		if (seen.has(assetId)) continue;
		seen.add(assetId);
		out.push({
			type: "asset_ref",
			assetId,
			path,
			assetType: assetType as LoomAssetType,
		});
	}
	return out;
}

const ASSET_BLOCK = /<asset_ref>\npath: ([^\n]*)\nasset_id: ([^\n]+)\ntype: (image|video|audio|text|other)\n<\/asset_ref>/g;

export type InlineAssetPart =
	| { type: "text"; text: string }
	| { type: "asset"; assetId: string };

function validAssetBlock(match: RegExpMatchArray): boolean {
	const path = match[1] ?? "";
	const assetType = match[3] ?? "";
	return isRelativeLibraryPath(path) && ASSET_TYPES.has(assetType);
}

/**
 * `<asset_ref>` blocks in place.
 * Blank lines the fold inserts around a block are not part of the chip.
 */
export function splitStoredAssetText(text: string): InlineAssetPart[] {
	const parts: InlineAssetPart[] = [];
	let cursor = 0;
	for (const match of text.matchAll(new RegExp(ASSET_BLOCK.source, "g"))) {
		const index = match.index ?? 0;
		if (index < cursor || !validAssetBlock(match) || !match[2]) continue;
		const before = text.slice(cursor, index).replace(/\n{1,2}$/, "");
		if (before) parts.push({ type: "text", text: before });
		parts.push({ type: "asset", assetId: match[2] });
		let end = index + match[0].length;
		const lead = /^\n{1,2}/.exec(text.slice(end));
		if (lead) end += lead[0].length;
		cursor = end;
	}
	const rest = text.slice(cursor);
	if (rest) parts.push({ type: "text", text: rest });
	return parts;
}

/** Replace each `<asset_ref>` block. Return null to leave that block unchanged. */
export function replaceAssetRefBlocks(text: string, replace: (block: AssetRefAttachment) => string | null): string {
	return text.replace(new RegExp(ASSET_BLOCK.source, "g"), (raw, path: string, assetId: string, assetType: string) => {
		if (!isRelativeLibraryPath(path) || !ASSET_TYPES.has(assetType)) return raw;
		const next = replace({ type: "asset_ref", assetId, path, assetType: assetType as LoomAssetType });
		return next ?? raw;
	});
}
export function assetRefBlocks(text: string): AssetRefAttachment[] {
	const out: AssetRefAttachment[] = [];
	for (const match of text.matchAll(new RegExp(ASSET_BLOCK.source, "g"))) {
		if (!validAssetBlock(match) || !match[1] || !match[2] || !match[3]) continue;
		const assetType = match[3] as LoomAssetType;
		out.push({ type: "asset_ref", assetId: match[2], path: match[1], assetType });
	}
	return out;
}

/** Chips that sit in the user text. A sidecar attachment only fills in a chip the text already names. */
export function displayAssetRefs(text: string, stored: readonly LoomUserAttachment[]): LoomUserAttachment[] {
	const byId = new Map<string, LoomUserAttachment>();
	for (const row of stored) {
		if (!byId.has(row.assetId)) byId.set(row.assetId, row);
	}
	const blocks = new Map(assetRefBlocks(text).map((row) => [row.assetId, row]));
	const out: LoomUserAttachment[] = [];
	const seen = new Set<string>();
	for (const part of splitStoredAssetText(text)) {
		if (part.type !== "asset" || seen.has(part.assetId)) continue;
		seen.add(part.assetId);
		out.push(byId.get(part.assetId) ?? blocks.get(part.assetId) ?? {
			type: "asset_ref",
			assetId: part.assetId,
			path: "file",
			assetType: "other",
		});
	}
	return out;
}

export function inlineAssetIds(text: string): string[] {
	return splitStoredAssetText(text).flatMap((part) => part.type === "asset" ? [part.assetId] : []);
}

/** Words only, for titles and labels. Stored `<asset_ref>` blocks are removed. */
export function stripInlineAssetRefs(text: string): string {
	return text.replace(new RegExp(ASSET_BLOCK.source, "g"), "");
}

/** Copilot measures this string for wrap. One space per `<asset_ref>` chip. */
export function composerLayoutText(text: string): string {
	return splitStoredAssetText(text).map((part) => (part.type === "text" ? part.text : " ")).join("");
}

/** Library chips already stored on a user message. A library highlight is not a chip. */
export function storedAssetRefs(value: unknown): LoomUserAttachment[] {
	if (!Array.isArray(value)) return [];
	const out: LoomUserAttachment[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		if (row.type !== "asset_ref") continue;
		try {
			const first = parseComposerAssetInputs([row])[0];
			if (first) out.push(first);
		} catch {
			// Leave a bad row off the chip list.
		}
	}
	return out;
}
