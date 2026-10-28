import { isRelativeLibraryPath } from "@loom/agent/composer-asset";

/** A clickable library file. Identity is `assetId`; `path` is library-relative. */
export type AssetRef = {
	assetId: string;
	path: string;
	filename: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === "string") {
		try {
			return asRecord(JSON.parse(value) as unknown);
		} catch {
			return null;
		}
	}
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	return null;
}

function readRef(value: unknown): AssetRef | null {
	const row = asRecord(value);
	if (!row) return null;
	const assetId = typeof row.assetId === "string" ? row.assetId.trim() : "";
	const path = typeof row.relativePath === "string" ? row.relativePath : typeof row.path === "string" ? row.path : "";
	if (!assetId || !isRelativeLibraryPath(path)) return null;
	const filename = typeof row.filename === "string" && row.filename.trim() ? row.filename : path;
	return { assetId, path, filename };
}

function pushRef(out: AssetRef[], seen: Set<string>, value: unknown): void {
	const ref = readRef(value);
	if (!ref || seen.has(ref.assetId)) return;
	seen.add(ref.assetId);
	out.push(ref);
}

/**
 * Clickable files from `search_assets` / `deep_search_assets` / `inspect_asset`.
 * Returns null for every other tool.
 */
export function assetRefsFromTool(name: string, result: unknown): AssetRef[] | null {
	const isSearch = name === "search_assets" || name === "deep_search_assets";
	if (!isSearch && name !== "inspect_asset") return null;
	const direct = asRecord(result);
	const row = direct && (Array.isArray(direct.assets) || typeof direct.assetId === "string")
		? direct
		: direct && "content" in direct
			? asRecord(direct.content)
			: direct;
	if (!row) return [];
	const out: AssetRef[] = [];
	const seen = new Set<string>();
	if (isSearch) {
		const assets = Array.isArray(row.assets) ? row.assets : [];
		for (const asset of assets) pushRef(out, seen, asset);
		return out;
	}
	pushRef(out, seen, row);
	const links = row.links;
	if (Array.isArray(links)) {
		for (const link of links) {
			const record = asRecord(link);
			pushRef(out, seen, record?.asset);
		}
	}
	return out;
}
