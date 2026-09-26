import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Asset } from "../model/asset.ts";
import {
	IMAGE_VLM_MAX_BYTES,
	normalizeImageVlmMarkdown,
	type ImageVlmProvider,
	type ImageVlmRecord,
	type ImageVlmStatus,
} from "../model/image-vlm.ts";
import type { MetadataStore } from "../stores/types.ts";

const IMAGE_MEDIA_TYPES = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);

export class ImageVlmService {
	private chain: Promise<void> = Promise.resolve();
	private readonly metadata: MetadataStore;
	private readonly resolvePath: (assetId: string) => Promise<string | undefined>;

	constructor(metadata: MetadataStore, resolvePath: (assetId: string) => Promise<string | undefined>) {
		this.metadata = metadata;
		this.resolvePath = resolvePath;
	}

	async getStatus(assetId: string, currentModelId?: string): Promise<ImageVlmStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.statusFor(asset, currentModelId);
	}

	async describe(
		assetId: string,
		provider: ImageVlmProvider,
		onUpdate?: (status: ImageVlmStatus) => void,
	): Promise<ImageVlmStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.enqueue(() => this.run(asset, provider, onUpdate));
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async run(
		asset: Asset,
		provider: ImageVlmProvider,
		onUpdate?: (status: ImageVlmStatus) => void,
	): Promise<ImageVlmStatus> {
		if (!canDescribeImage(asset)) return unsupportedStatus(asset);

		const current = await this.currentIfFresh(asset, provider.modelId);
		if (current) return current;

		await this.writeRecord(asset, {
			status: "describing",
			modelId: provider.modelId,
			error: undefined,
		});
		onUpdate?.(await this.statusFor(asset, provider.modelId));

		try {
			if (asset.size > IMAGE_VLM_MAX_BYTES) {
				throw new Error("Image VLM accepts files up to 10 MB");
			}
			const absolutePath = await this.resolvePath(asset.assetId);
			if (!absolutePath) throw new Error("Asset not found");
			const bytes = await readFile(absolutePath);
			const markdown = normalizeImageVlmMarkdown(await provider.describe({ filename: asset.filename, bytes }));
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

	private async currentIfFresh(asset: Asset, modelId: string): Promise<ImageVlmStatus | undefined> {
		const record = await this.metadata.getImageVlm(asset.assetId);
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
			status: ImageVlmRecord["status"];
			modelId?: string;
			error?: string;
			markdown?: string;
			clearMarkdown?: boolean;
		},
	): Promise<void> {
		const previous = await this.metadata.getImageVlm(asset.assetId);
		await this.metadata.upsertImageVlm({
			assetId: asset.assetId,
			status: patch.status,
			modelId: patch.modelId ?? previous?.modelId,
			sourceModifiedAt: asset.modifiedAt,
			error: patch.error,
			markdown: patch.clearMarkdown ? undefined : (patch.markdown ?? previous?.markdown),
			updatedAt: Date.now(),
		});
	}

	private async statusFor(asset: Asset, currentModelId?: string): Promise<ImageVlmStatus> {
		if (!canDescribeImage(asset)) return unsupportedStatus(asset);
		const record = await this.metadata.getImageVlm(asset.assetId);
		if (!record) return idleStatus(asset);
		return toStatus(asset, record, currentModelId);
	}
}

export function canDescribeImage(asset: Asset): boolean {
	return asset.type === "image" && IMAGE_MEDIA_TYPES.has(extname(asset.filename).toLowerCase());
}

function toStatus(asset: Asset, record: ImageVlmRecord, currentModelId?: string): ImageVlmStatus {
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

function idleStatus(asset: Asset): ImageVlmStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: true,
	};
}

function unsupportedStatus(asset: Asset): ImageVlmStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: false,
	};
}
