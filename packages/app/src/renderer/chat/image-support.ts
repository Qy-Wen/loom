import type { LoomSessionModel, LoomUserAttachment } from "@loom/agent";
import { isComposerImagePath } from "@loom/agent/composer-image";
import type { ChatModelView } from "../../shared/chat-models.ts";

/**
 * True when the model is known to take only text. pi-ai replaces images with a placeholder for such
 * models. An unknown model (not loaded yet, or removed from Settings) is never reported, so the notice
 * does not flash while the catalog loads.
 */
export function modelLacksImageInput(
	model: LoomSessionModel | undefined,
	models: readonly Pick<ChatModelView, "provider" | "id" | "input">[] | null,
): boolean {
	if (!model || !models) return false;
	const row = models.find((item) => item.provider === model.provider && item.id === model.modelId);
	return row !== undefined && !row.input.includes("image");
}

/** Whether any attached file is sent to the model as an image block (JPEG, PNG, GIF, WebP). */
export function hasImageAsset(assets: readonly Pick<LoomUserAttachment, "assetType" | "path">[]): boolean {
	return assets.some((asset) => asset.assetType === "image" && isComposerImagePath(asset.path));
}
