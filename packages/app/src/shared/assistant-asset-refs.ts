/**
 * An assistant reply names a library file with the same `<asset_ref>` block the composer stores.
 * `asset_id` is looked up first. A miss falls back to `path`. Anything else stays visible and is not a link.
 * An unfinished block is split off so markdown does not drop it while it streams.
 */
export function prepareAssistantContent(
	text: string,
	library: ReadonlyMap<string, { path: string }>,
): { markdown: string; rawTail: string } {
	const open = unclosedAssetBlock(text);
	const head = open < 0 ? text : text.slice(0, open);
	const rawTail = open < 0 ? "" : text.slice(open);
	const byPath = new Map<string, string>();
	for (const [assetId, asset] of library) {
		if (!byPath.has(asset.path)) byPath.set(asset.path, assetId);
	}
	const linked = head.replace(ASSET_BLOCK, (_raw, path: string, assetId: string | undefined) => mention(path, assetId, library, byPath));
	return { markdown: linked, rawTail };
}

const ASSET_BLOCK = /<asset_ref>\npath: ([^\n]*)\n(?:asset_id: ([^\n]*)\n)?(?:type: [^\n]*\n)?<\/asset_ref>/g;

function mention(
	path: string,
	assetId: string | undefined,
	library: ReadonlyMap<string, { path: string }>,
	byPath: ReadonlyMap<string, string>,
): string {
	const written = path.trim();
	const id = assetId?.trim() ?? "";
	const live = id.length > 0 ? library.get(id) : undefined;
	if (live) return link(live.path, "loom-asset", id);
	const key = written.replaceAll("\\", "/");
	const found = key.length > 0 ? byPath.get(key) : undefined;
	if (found) return link(key, "loom-asset", found);
	return link(written || id, "loom-missing", written || id);
}

function link(label: string, kind: "loom-asset" | "loom-missing", value: string): string {
	return `[${linkLabel(label)}](#${kind}:${encodeURIComponent(value)})`;
}

function unclosedAssetBlock(text: string): number {
	const open = text.lastIndexOf("<asset_ref");
	if (open < 0) return -1;
	const end = text.indexOf(">", open);
	if (end < 0) return open;
	return text.indexOf("</asset_ref>", end) >= 0 ? -1 : open;
}

function linkLabel(name: string): string {
	return name.replace(/[\\[\]*_`]/g, (ch) => `\\${ch}`);
}
