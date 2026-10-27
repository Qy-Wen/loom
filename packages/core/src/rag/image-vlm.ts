import { abortableProviderCall } from "../library/task-scope.ts";
import { extname } from "node:path";
import type { Asset } from "../model/asset.ts";
import {
	IMAGE_VLM_MAX_BYTES,
	normalizeImageVlmMarkdown,
	type ImagePrepareFn,
	type ImageVlmProvider,
	type ImageVlmStatus,
} from "../model/image-vlm.ts";
import type { MetadataStore } from "../stores/types.ts";
import { DescriptionService, type DescribeOptions } from "./description.ts";

const IMAGE_MEDIA_TYPES = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);

export class ImageVlmService {
	private readonly descriptions: DescriptionService<ImageVlmProvider>;

	constructor(
		metadata: MetadataStore,
		resolvePath: (assetId: string) => Promise<string | undefined>,
		prepare: ImagePrepareFn,
	) {
		this.descriptions = new DescriptionService<ImageVlmProvider>({
			getAsset: (assetId) => metadata.getAsset(assetId),
			getRecord: (assetId) => metadata.getImageVlm(assetId),
			writeRecord: (record) => metadata.upsertImageVlm(record),
			supports: canDescribeImage,
			generate: async (asset, provider, signal) => {
				if (asset.size > IMAGE_VLM_MAX_BYTES) {
					throw new Error("Image VLM accepts files up to 10 MB");
				}
				const absolutePath = await resolvePath(asset.assetId);
				if (!absolutePath) throw new Error("Asset not found");
				const image = await prepare(absolutePath, signal);
				if (image.bytes.byteLength > IMAGE_VLM_MAX_BYTES) {
					throw new Error("Image VLM accepts files up to 10 MB");
				}
				return normalizeImageVlmMarkdown(await abortableProviderCall(() => provider.describe(image, signal), signal));
			},
		});
	}

	getStatus(assetId: string, currentModelId?: string): Promise<ImageVlmStatus> {
		return this.descriptions.getStatus(assetId, currentModelId);
	}

	describe(
		assetId: string,
		provider: ImageVlmProvider,
		onUpdate?: (status: ImageVlmStatus) => void,
		signal?: AbortSignal,
		options?: DescribeOptions,
	): Promise<ImageVlmStatus> {
		return this.descriptions.describe(assetId, provider, onUpdate, signal, options);
	}
}

export function canDescribeImage(asset: Asset): boolean {
	return asset.type === "image" && IMAGE_MEDIA_TYPES.has(extname(asset.filename).toLowerCase());
}
