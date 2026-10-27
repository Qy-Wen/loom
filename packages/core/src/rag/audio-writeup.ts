import { abortableProviderCall } from "../library/task-scope.ts";
import { extname } from "node:path";
import type { Asset } from "../model/asset.ts";
import {
	normalizeAudioWriteupMarkdown,
	type AudioPrepareFn,
	type AudioWriteupProvider,
	type AudioWriteupStatus,
} from "../model/audio-writeup.ts";
import type { MetadataStore } from "../stores/types.ts";
import { DescriptionService, type DescribeOptions } from "./description.ts";

const AUDIO_MEDIA_TYPES = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);

export class AudioWriteupService {
	private readonly descriptions: DescriptionService<AudioWriteupProvider>;

	constructor(
		metadata: MetadataStore,
		resolvePath: (assetId: string) => Promise<string | undefined>,
		prepare: AudioPrepareFn,
	) {
		this.descriptions = new DescriptionService<AudioWriteupProvider>({
			getAsset: (assetId) => metadata.getAsset(assetId),
			getRecord: (assetId) => metadata.getAudioWriteup(assetId),
			writeRecord: (record) => metadata.upsertAudioWriteup(record),
			supports: canDescribeAudio,
			generate: async (asset, provider, signal) => {
				const absolutePath = await resolvePath(asset.assetId);
				if (!absolutePath) throw new Error("Asset not found");
				const prepared = await prepare(absolutePath, asset.size, signal);
				return normalizeAudioWriteupMarkdown(await abortableProviderCall(() => provider.describe(prepared, signal), signal));
			},
		});
	}

	getStatus(assetId: string, currentModelId?: string): Promise<AudioWriteupStatus> {
		return this.descriptions.getStatus(assetId, currentModelId);
	}

	describe(
		assetId: string,
		provider: AudioWriteupProvider,
		onUpdate?: (status: AudioWriteupStatus) => void,
		signal?: AbortSignal,
		options?: DescribeOptions,
	): Promise<AudioWriteupStatus> {
		return this.descriptions.describe(assetId, provider, onUpdate, signal, options);
	}
}

export function canDescribeAudio(asset: Asset): boolean {
	return asset.type === "audio" && AUDIO_MEDIA_TYPES.has(extname(asset.filename).toLowerCase());
}
