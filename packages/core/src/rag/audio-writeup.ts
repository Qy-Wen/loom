import { extname } from "node:path";
import type { Asset } from "../model/asset.ts";
import {
	normalizeAudioWriteupMarkdown,
	type AudioPrepareFn,
	type AudioWriteupProvider,
	type AudioWriteupRecord,
	type AudioWriteupStatus,
} from "../model/audio-writeup.ts";
import type { MetadataStore } from "../stores/types.ts";

const AUDIO_MEDIA_TYPES = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav"]);

export class AudioWriteupService {
	private chain: Promise<void> = Promise.resolve();
	private readonly metadata: MetadataStore;
	private readonly resolvePath: (assetId: string) => Promise<string | undefined>;
	private readonly prepare: AudioPrepareFn;

	constructor(
		metadata: MetadataStore,
		resolvePath: (assetId: string) => Promise<string | undefined>,
		prepare: AudioPrepareFn,
	) {
		this.metadata = metadata;
		this.resolvePath = resolvePath;
		this.prepare = prepare;
	}

	async getStatus(assetId: string, currentModelId?: string): Promise<AudioWriteupStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.statusFor(asset, currentModelId);
	}

	async describe(
		assetId: string,
		provider: AudioWriteupProvider,
		onUpdate?: (status: AudioWriteupStatus) => void,
	): Promise<AudioWriteupStatus> {
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
		provider: AudioWriteupProvider,
		onUpdate?: (status: AudioWriteupStatus) => void,
	): Promise<AudioWriteupStatus> {
		if (!canDescribeAudio(asset)) return unsupportedStatus(asset);

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
			const prepared = await this.prepare(absolutePath, asset.size);
			const markdown = normalizeAudioWriteupMarkdown(await provider.describe(prepared));
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

	private async currentIfFresh(asset: Asset, modelId: string): Promise<AudioWriteupStatus | undefined> {
		const record = await this.metadata.getAudioWriteup(asset.assetId);
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
			status: AudioWriteupRecord["status"];
			modelId?: string;
			error?: string;
			markdown?: string;
			clearMarkdown?: boolean;
		},
	): Promise<void> {
		const previous = await this.metadata.getAudioWriteup(asset.assetId);
		await this.metadata.upsertAudioWriteup({
			assetId: asset.assetId,
			status: patch.status,
			modelId: patch.modelId ?? previous?.modelId,
			sourceModifiedAt: asset.modifiedAt,
			error: patch.error,
			markdown: patch.clearMarkdown ? undefined : (patch.markdown ?? previous?.markdown),
			updatedAt: Date.now(),
		});
	}

	private async statusFor(asset: Asset, currentModelId?: string): Promise<AudioWriteupStatus> {
		if (!canDescribeAudio(asset)) return unsupportedStatus(asset);
		const record = await this.metadata.getAudioWriteup(asset.assetId);
		if (!record) return idleStatus(asset);
		return toStatus(asset, record, currentModelId);
	}
}

export function canDescribeAudio(asset: Asset): boolean {
	return asset.type === "audio" && AUDIO_MEDIA_TYPES.has(extname(asset.filename).toLowerCase());
}

function toStatus(asset: Asset, record: AudioWriteupRecord, currentModelId?: string): AudioWriteupStatus {
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

function idleStatus(asset: Asset): AudioWriteupStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: true,
	};
}

function unsupportedStatus(asset: Asset): AudioWriteupStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: false,
	};
}
