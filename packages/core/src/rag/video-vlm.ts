import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Asset } from "../model/asset.ts";
import { normalizeImageVlmMarkdown } from "../model/image-vlm.ts";
import {
	VIDEO_VLM_NATIVE_MAX_BYTES,
	type VideoFrameExtractor,
	type VideoVlmNativeInput,
	type VideoVlmProvider,
	type VideoVlmRecord,
	type VideoVlmStatus,
} from "../model/video-vlm.ts";
import type { MetadataStore } from "../stores/types.ts";

const VIDEO_MEDIA_TYPES = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);

export class VideoVlmService {
	private chain: Promise<void> = Promise.resolve();
	private readonly metadata: MetadataStore;
	private readonly resolvePath: (assetId: string) => Promise<string | undefined>;
	private readonly extractFrames: VideoFrameExtractor;

	constructor(
		metadata: MetadataStore,
		resolvePath: (assetId: string) => Promise<string | undefined>,
		extractFrames: VideoFrameExtractor,
	) {
		this.metadata = metadata;
		this.resolvePath = resolvePath;
		this.extractFrames = extractFrames;
	}

	async getStatus(assetId: string, currentModelId?: string): Promise<VideoVlmStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.statusFor(asset, currentModelId);
	}

	async describe(
		assetId: string,
		provider: VideoVlmProvider,
		onUpdate?: (status: VideoVlmStatus) => void,
		signal?: AbortSignal,
	): Promise<VideoVlmStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.enqueue(() => this.run(asset, provider, onUpdate, signal));
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async run(
		asset: Asset,
		provider: VideoVlmProvider,
		onUpdate?: (status: VideoVlmStatus) => void,
		signal?: AbortSignal,
	): Promise<VideoVlmStatus> {
		if (!canDescribeVideo(asset)) return unsupportedStatus(asset);

		const current = await this.currentIfFresh(asset, provider.modelId);
		if (current) return current;

		await this.writeRecord(asset, {
			status: "describing",
			modelId: provider.modelId,
			error: undefined,
		});
		onUpdate?.(await this.statusFor(asset, provider.modelId));

		try {
			const absolutePath = await this.resolvePath(asset.assetId);
			if (!absolutePath) throw new Error("Asset not found");
			const native = await nativeInput(asset, absolutePath);
			const markdown = normalizeImageVlmMarkdown(await provider.describe({
				native,
				frames: () => this.extractFrames(absolutePath, signal),
			}, signal));
			await this.writeRecord(asset, {
				status: "ready",
				modelId: provider.modelId,
				error: undefined,
				markdown,
			});
			return this.statusFor(asset, provider.modelId);
		} catch (error) {
			await this.writeRecord(asset, {
				status: "failed",
				modelId: provider.modelId,
				error: error instanceof Error ? error.message : String(error),
				clearMarkdown: true,
			});
			return this.statusFor(asset, provider.modelId);
		}
	}

	private async currentIfFresh(asset: Asset, modelId: string): Promise<VideoVlmStatus | undefined> {
		const record = await this.metadata.getVideoVlm(asset.assetId);
		if (
			record?.status !== "ready"
			|| record.modelId !== modelId
			|| record.sourceModifiedAt !== asset.modifiedAt
			|| !record.markdown?.trim()
		) {
			return undefined;
		}
		return toStatus(asset, record, modelId);
	}

	private async writeRecord(
		asset: Asset,
		patch: {
			status: VideoVlmRecord["status"];
			modelId?: string;
			error?: string;
			markdown?: string;
			clearMarkdown?: boolean;
		},
	): Promise<void> {
		const previous = await this.metadata.getVideoVlm(asset.assetId);
		await this.metadata.upsertVideoVlm({
			assetId: asset.assetId,
			status: patch.status,
			modelId: patch.modelId ?? previous?.modelId,
			sourceModifiedAt: asset.modifiedAt,
			error: patch.error,
			markdown: patch.clearMarkdown ? undefined : (patch.markdown ?? previous?.markdown),
			updatedAt: Date.now(),
		});
	}

	private async statusFor(asset: Asset, currentModelId?: string): Promise<VideoVlmStatus> {
		if (!canDescribeVideo(asset)) return unsupportedStatus(asset);
		const record = await this.metadata.getVideoVlm(asset.assetId);
		if (!record) return idleStatus(asset);
		return toStatus(asset, record, currentModelId);
	}
}

export function canDescribeVideo(asset: Asset): boolean {
	return asset.type === "video" && VIDEO_MEDIA_TYPES.has(extname(asset.filename).toLowerCase());
}

async function nativeInput(asset: Asset, absolutePath: string): Promise<VideoVlmNativeInput | undefined> {
	if (asset.size > VIDEO_VLM_NATIVE_MAX_BYTES) return undefined;
	return { filename: asset.filename, bytes: await readFile(absolutePath) };
}

function toStatus(asset: Asset, record: VideoVlmRecord, currentModelId?: string): VideoVlmStatus {
	const stale = record.sourceModifiedAt !== asset.modifiedAt
		|| (currentModelId !== undefined && record.modelId !== undefined && record.modelId !== currentModelId);
	return {
		assetId: asset.assetId,
		status: record.status,
		stale,
		supported: true,
		modelId: record.modelId,
		sourceModifiedAt: record.sourceModifiedAt,
		error: record.error,
		markdown: record.markdown,
	};
}

function idleStatus(asset: Asset): VideoVlmStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: true,
	};
}

function unsupportedStatus(asset: Asset): VideoVlmStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: false,
	};
}
