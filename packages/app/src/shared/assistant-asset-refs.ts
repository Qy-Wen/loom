/**
 * Assistant replies use the same `<asset_ref>` / `<folder_ref>` blocks the composer stores.
 * A model that writes the attribute form (`<asset_ref path="…" asset_id="…" />`) is read the same way.
 * `asset_id` is looked up first. A miss falls back to `path`. Anything else stays visible and is not a link.
 * An unfinished block is split off so markdown does not drop it while it streams.
 */
export function prepareAssistantContent(
	text: string,
	library: ReadonlyMap<string, { path: string }>,
	folders: ReadonlySet<string> = new Set(),
): { markdown: string; rawTail: string } {
	const open = unclosedAssetBlock(text);
	const head = open < 0 ? text : text.slice(0, open);
	const rawTail = open < 0 ? "" : text.slice(open);
	const byPath = new Map<string, string>();
	for (const [assetId, asset] of library) {
		if (!byPath.has(asset.path)) byPath.set(asset.path, assetId);
	}
	const linked = head
		.replace(FOLDER_BLOCK, (_raw, path: string) => folderMention(path, folders))
		.replace(FOLDER_TAG, (_raw, attributes: string) => {
			const { path } = readAttributes(attributes);
			return path === undefined ? _raw : folderMention(path, folders);
		})
		.replace(ASSET_BLOCK, (_raw, path: string, assetId: string | undefined) => mention(path, assetId, library, byPath))
		.replace(ASSET_TAG, (_raw, attributes: string) => {
			const { path, asset_id: assetId } = readAttributes(attributes);
			return path === undefined ? _raw : mention(path, assetId, library, byPath);
		});
	return { markdown: linked, rawTail };
}

const ASSET_BLOCK = /<asset_ref>\npath: ([^\n]*)\n(?:asset_id: ([^\n]*)\n)?(?:type: [^\n]*\n)?<\/asset_ref>/g;

const ASSET_TAG = /<asset_ref\s+([^<>]*?)\s*(?:\/>|>\s*<\/asset_ref>)/g;
const FOLDER_BLOCK = /<folder_ref>\npath: ([^\n]*)\n<\/folder_ref>/g;
const FOLDER_TAG = /<folder_ref\s+([^<>]*?)\s*(?:\/>|>\s*<\/folder_ref>)/g;

function folderMention(path: string, folders: ReadonlySet<string>): string {
	const key = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	return link(key, folders.has(key) ? "loom-folder" : "loom-missing", key);
}

function readAttributes(text: string): Record<string, string> {
	const found: Record<string, string> = {};
	for (const match of text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) found[match[1]!] = match[2] ?? match[3] ?? "";
	return found;
}

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

function link(label: string, kind: "loom-asset" | "loom-folder" | "loom-missing", value: string): string {
	return `[${linkLabel(label)}](#${kind}:${encodeURIComponent(value)})`;
}

function unclosedAssetBlock(text: string): number {
	const open = Math.max(text.lastIndexOf("<asset_ref"), text.lastIndexOf("<folder_ref"));
	if (open < 0) return -1;
	const end = text.indexOf(">", open);
	if (end < 0) return open;
	if (text[end - 1] === "/") return -1;
	const closing = text.startsWith("<folder_ref", open) ? "</folder_ref>" : "</asset_ref>";
	return text.indexOf(closing, end) >= 0 ? -1 : open;
}

function linkLabel(name: string): string {
	return name.replace(/[\\[\]*_`]/g, (ch) => `\\${ch}`);
}
