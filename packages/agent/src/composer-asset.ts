/** Composer chips: library assets staged for the next user message. They become `asset_ref` attachments. */

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

const ASSET_REF = /\u2060loom-asset:([^\u2060]+)\u2060/g;

export type InlineAssetPart =
	| { type: "text"; text: string }
	| { type: "asset"; assetId: string };

/** Marks where a library chip sits in the user text. The id is the asset id. */
export function assetRefMarker(assetId: string): string {
	return `\u2060loom-asset:${assetId}\u2060`;
}

/** Split user text into words and the chips placed among them. */
export function splitInlineAssetRefs(text: string): InlineAssetPart[] {
	const parts: InlineAssetPart[] = [];
	const re = new RegExp(ASSET_REF.source, "g");
	let last = 0;
	for (const match of text.matchAll(re)) {
		const index = match.index ?? 0;
		if (index > last) parts.push({ type: "text", text: text.slice(last, index) });
		const assetId = match[1];
		if (assetId) parts.push({ type: "asset", assetId });
		last = index + match[0].length;
	}
	if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
	return parts;
}

export function inlineAssetIds(text: string): string[] {
	return splitInlineAssetRefs(text).flatMap((part) => part.type === "asset" ? [part.assetId] : []);
}

/** Words only, for titles and labels. Chip markers are removed. */
export function stripInlineAssetRefs(text: string): string {
	return text.replace(new RegExp(ASSET_REF.source, "g"), "");
}

/** Copilot measures this string for wrap. One space per chip, no hidden ids. */
export function composerLayoutText(text: string): string {
	return splitInlineAssetRefs(text).map((part) => (part.type === "text" ? part.text : " ")).join("");
}

/** Library chips already stored on a user message. Rows that are not relative refs are skipped. */
export function storedAssetRefs(value: unknown): LoomUserAttachment[] {
	if (!Array.isArray(value)) return [];
	const out: LoomUserAttachment[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const row = item as Record<string, unknown>;
		const kind = row.type === "ui_selection" ? "ui_selection" : row.type === "asset_ref" ? "asset_ref" : null;
		if (!kind) continue;
		try {
			const first = parseComposerAssetInputs([{ ...row, type: "asset_ref" }])[0];
			if (first) out.push(kind === "asset_ref" ? first : { ...first, type: "ui_selection" });
		} catch {
			// Leave a bad row off the chip list.
		}
	}
	return out;
}
