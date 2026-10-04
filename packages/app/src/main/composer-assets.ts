import type { AssetRefAttachment, LoomAssetType } from "@loom/agent";
import { isRelativeLibraryPath, parseComposerAssetInputs } from "@loom/agent/composer-asset";

const staged = new Map<string, AssetRefAttachment[]>();

const ASSET_TYPES = new Set<string>(["image", "video", "audio", "text", "other"]);

export type LiveComposerAsset = {
	assetId: string;
	relativePath: string;
	type: string;
};

export function stageComposerAssets(sessionId: string, value: unknown): void {
	const assets = parseComposerAssetInputs(value);
	if (assets.length === 0) staged.delete(sessionId);
	else staged.set(sessionId, assets);
}

/** Take the library assets staged for the next user message. Stored on that message's attachments. */
export async function takeComposerAssets(sessionId: string): Promise<AssetRefAttachment[]> {
	const inputs = staged.get(sessionId) ?? [];
	staged.delete(sessionId);
	return inputs;
}

/** Rewrite chip path/type from the live library. Missing or invalid live rows keep the staged snapshot. */
export function composerAssetsAtSend(
	chips: readonly AssetRefAttachment[],
	live: ReadonlyArray<LiveComposerAsset>,
): AssetRefAttachment[] {
	if (chips.length === 0) return [];
	const byId = new Map(live.map((asset) => [asset.assetId, asset]));
	return chips.map((chip) => {
		const asset = byId.get(chip.assetId);
		if (!asset) return chip;
		if (!isRelativeLibraryPath(asset.relativePath)) return chip;
		if (!ASSET_TYPES.has(asset.type)) return chip;
		if (asset.relativePath === chip.path && asset.type === chip.assetType) return chip;
		return {
			type: "asset_ref",
			assetId: chip.assetId,
			path: asset.relativePath,
			assetType: asset.type as LoomAssetType,
		};
	});
}
