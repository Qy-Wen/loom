import { type AssetRefAttachment, type LoomAssetType } from "@loom/agent/attachments";
import { isRelativeLibraryPath, replaceAssetRefBlocks } from "@loom/agent/composer-asset";

/**
 * Assistant prose may contain `<asset_ref>` blocks copied from tool results.
 * A block whose id is in the open library becomes an inline link the bubble
 * draws as a button. Anything else stays visible text. An unfinished block
 * is split off so markdown does not drop the opening tag while it streams.
 */
export function prepareAssistantContent(
	text: string,
	knownFilenames: ReadonlyMap<string, string>,
): { markdown: string; rawTail: string } {
	const open = unclosedAssetRef(text);
	const head = open < 0 ? text : text.slice(0, open);
	const rawTail = open < 0 ? "" : text.slice(open);
	const link = (block: AssetRefAttachment): string | null => {
		const filename = knownFilenames.get(block.assetId);
		if (!filename) return null;
		const label = linkLabel(filename);
		return `[${label}](#loom-asset:${encodeURIComponent(block.assetId)})`;
	};
	const linked = replaceAttributeRefs(replaceAssetRefBlocks(head, link), link);
	return { markdown: escapeLeftoverBlocks(linked), rawTail };
}

const ASSET_TYPES = new Set<LoomAssetType>(["image", "video", "audio", "text", "other"]);
const ATTR_TAG = /<asset_ref\s+([^>]*?)\s*\/?>/g;

function replaceAttributeRefs(text: string, replace: (block: AssetRefAttachment) => string | null): string {
	return text.replace(ATTR_TAG, (raw, body: string) => {
		const block = attributeBlock(body);
		if (!block) return raw;
		return replace(block) ?? raw;
	});
}

function attributeBlock(source: string): AssetRefAttachment | null {
	const attrs = new Map<string, string>();
	for (const match of source.matchAll(/([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		attrs.set(match[1]!.toLowerCase(), match[2] ?? match[3] ?? "");
	}
	const path = attrs.get("path");
	const assetId = attrs.get("asset_id");
	const assetType = attrs.get("type");
	if (path === undefined || !assetId || !assetType || !ASSET_TYPES.has(assetType as LoomAssetType)) return null;
	if (!isRelativeLibraryPath(path)) return null;
	return { type: "asset_ref", assetId, path, assetType: assetType as LoomAssetType };
}

function unclosedAssetRef(text: string): number {
	const open = text.lastIndexOf("<asset_ref");
	if (open < 0) return -1;
	const end = text.indexOf(">", open);
	if (end < 0) return open;
	const tag = text.slice(open, end + 1);
	if (tag !== "<asset_ref>") return -1;
	return text.indexOf("</asset_ref>", open) >= 0 ? -1 : open;
}

function escapeLeftoverBlocks(text: string): string {
	return text
		.replace(/<asset_ref>[\s\S]*?<\/asset_ref>/g, (raw) => escapeHtml(raw))
		.replace(ATTR_TAG, (raw) => escapeHtml(raw));
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkLabel(name: string): string {
	return name.replace(/[\\[\]*_`]/g, (ch) => `\\${ch}`);
}
