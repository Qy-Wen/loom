import { formatAssetRefBlock } from "@loom/agent/attachments";
import { replaceAssetRefBlocks } from "@loom/agent/composer-asset";

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
	const linked = replaceAssetRefBlocks(head, (block) => {
		const filename = knownFilenames.get(block.assetId);
		if (!filename) return escapeHtml(formatAssetRefBlock(block));
		const label = linkLabel(filename);
		return `[${label}](#loom-asset:${encodeURIComponent(block.assetId)})`;
	});
	return { markdown: escapeLeftoverBlocks(linked), rawTail };
}

function unclosedAssetRef(text: string): number {
	const open = text.lastIndexOf("<asset_ref>");
	if (open < 0) return -1;
	return text.indexOf("</asset_ref>", open) >= 0 ? -1 : open;
}

function escapeLeftoverBlocks(text: string): string {
	return text.replace(/<asset_ref>[\s\S]*?<\/asset_ref>/g, (raw) => escapeHtml(raw));
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkLabel(name: string): string {
	return name.replace(/[\\[\]*_`]/g, (ch) => `\\${ch}`);
}
