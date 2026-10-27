import { open } from "node:fs/promises";
import { basename } from "node:path";
import { COMPOSER_IMAGE_MAX_BYTES, COMPOSER_IMAGE_MAX_COUNT, isComposerImagePath, parseComposerImageInputs, sniffComposerImage, type ComposerImageInput } from "@loom/agent";
import { parseComposerAssetInputs } from "@loom/agent/composer-asset";
import { stageComposerAssets } from "./composer-assets.ts";

const staged = new Map<string, ComposerImageInput[]>();

/** Resolve explicit chips by library ID, then stage references and image bytes together. */
export async function stageComposerInput(
	sessionId: string,
	value: unknown,
	resolveAsset: (assetId: string) => Promise<string | undefined>,
): Promise<void> {
	const assets = parseComposerAssetInputs(value);
	const images: ComposerImageInput[] = [];
	for (const asset of assets) {
		if (asset.assetType !== "image") continue;
		const path = await resolveAsset(asset.assetId);
		if (!path) throw new Error(`${asset.path} is no longer in the library.`);
		// Other image formats remain usable as library references.
		if (!isComposerImagePath(path)) continue;
		if (images.length >= COMPOSER_IMAGE_MAX_COUNT) throw new Error("Attach up to 4 images.");
		const file = await open(path, "r");
		try {
			const info = await file.stat();
			if (!info.isFile()) throw new Error(`${basename(path)} is not a file.`);
			if (info.size > COMPOSER_IMAGE_MAX_BYTES) throw new Error("Each image must be 8 MB or smaller.");
			// Bound the read even if another process grows the file after stat.
			const bytes = Buffer.alloc(Math.min(info.size + 1, COMPOSER_IMAGE_MAX_BYTES + 1));
			let length = 0;
			while (length < bytes.length) {
				const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
				if (!bytesRead) break;
				length += bytesRead;
			}
			const data = bytes.subarray(0, length);
			if (data.length > COMPOSER_IMAGE_MAX_BYTES) throw new Error("Each image must be 8 MB or smaller.");
			if (data.length !== info.size) throw new Error(`${basename(path)} changed while reading. Send again.`);
			const mimeType = sniffComposerImage(data);
			if (!mimeType) throw new Error(`${basename(path)} must be a JPEG, PNG, GIF, or WebP image.`);
			images.push({ filename: basename(path), mimeType, data: data.toString("base64") });
		} finally {
			await file.close();
		}
	}
	const validated = parseComposerImageInputs(images);
	stageComposerAssets(sessionId, assets);
	if (validated.length === 0) staged.delete(sessionId);
	else staged.set(sessionId, validated);
}

/** Take the images staged for the next user message. They are stored on that message's content. */
export async function takeComposerImages(sessionId: string): Promise<ComposerImageInput[]> {
	const inputs = staged.get(sessionId) ?? [];
	staged.delete(sessionId);
	return inputs;
}
