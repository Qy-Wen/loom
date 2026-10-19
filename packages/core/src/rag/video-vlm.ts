import { abortableProviderCall } from "../library/task-scope.ts";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Asset } from "../model/asset.ts";
import { normalizeImageVlmMarkdown } from "../model/image-vlm.ts";
import {
	VIDEO_VLM_NATIVE_MAX_BYTES,
	type VideoFrameExtractor,
	type VideoVlmFrame,
	type VideoVlmNativeInput,
	type VideoVlmProvider,
	type VideoVlmStatus,
} from "../model/video-vlm.ts";
import type { MetadataStore } from "../stores/types.ts";
import { DescriptionService } from "./description.ts";

const VIDEO_MEDIA_TYPES = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

export class VideoVlmService {
	private readonly descriptions: DescriptionService<VideoVlmProvider>;

	constructor(
		metadata: MetadataStore,
		resolvePath: (assetId: string) => Promise<string | undefined>,
		extractFrames: VideoFrameExtractor,
	) {
		this.descriptions = new DescriptionService<VideoVlmProvider>({
			getAsset: (assetId) => metadata.getAsset(assetId),
			getRecord: (assetId) => metadata.getVideoVlm(assetId),
			writeRecord: (record) => metadata.upsertVideoVlm(record),
			supports: canDescribeVideo,
			generate: async (asset, provider, signal) => {
				const absolutePath = await resolvePath(asset.assetId);
				if (!absolutePath) throw new Error("Asset not found");
				const native = await nativeInput(asset, absolutePath, signal);
				let extraction: Promise<VideoVlmFrame[]> | undefined;
				try {
					return normalizeImageVlmMarkdown(await abortableProviderCall(() => provider.describe({
						native,
						frames: () => {
							signal?.throwIfAborted();
							return extraction ??= extractFrames(absolutePath, signal);
						},
					}, signal), signal));
				} finally {
					// A provider may return or abort while its lazy extraction still owns temp files.
					await extraction?.catch(() => undefined);
				}
			},
		});
	}

	getStatus(assetId: string, currentModelId?: string): Promise<VideoVlmStatus> {
		return this.descriptions.getStatus(assetId, currentModelId);
	}

	describe(
		assetId: string,
		provider: VideoVlmProvider,
		onUpdate?: (status: VideoVlmStatus) => void,
		signal?: AbortSignal,
	): Promise<VideoVlmStatus> {
		return this.descriptions.describe(assetId, provider, onUpdate, signal);
	}
}

export function canDescribeVideo(asset: Asset): boolean {
	return asset.type === "video" && VIDEO_MEDIA_TYPES.has(extname(asset.filename).toLowerCase());
}

async function nativeInput(asset: Asset, absolutePath: string, signal?: AbortSignal): Promise<VideoVlmNativeInput | undefined> {
	if (asset.size > VIDEO_VLM_NATIVE_MAX_BYTES) return undefined;
	return { filename: asset.filename, bytes: await readFile(absolutePath, { signal }) };
}
