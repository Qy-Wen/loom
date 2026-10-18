import type { AssetType } from "@loom/core";
import type { UiSelectionFields } from "@loom/agent";

const ASSET_TYPES = new Set<AssetType>(["image", "video", "audio", "text", "other"]);

let current: UiSelectionFields | null = null;

export function getUiSelection(): UiSelectionFields | null {
	return current;
}

export function setUiSelection(next: UiSelectionFields | null): void {
	current = next;
}

export function parseUiSelectionDraft(raw: unknown): UiSelectionFields | null {
	if (raw === null) return null;
	if (typeof raw !== "object") return null;
	const row = raw as Record<string, unknown>;
	if (typeof row.assetId !== "string" || !row.assetId.trim()) return null;
	if (typeof row.path !== "string") return null;
	if (typeof row.assetType !== "string" || !ASSET_TYPES.has(row.assetType as AssetType)) return null;
	return {
		assetId: row.assetId,
		path: row.path,
		assetType: row.assetType as AssetType,
	};
}
