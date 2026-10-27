import { abortableProviderCall } from "../library/task-scope.ts";
import { randomUUID } from "node:crypto";
import { isEnrichmentStale } from "../model/enrichment.ts";
import type { Asset } from "../model/asset.ts";
import {
	EMBED_BATCH_SIZE,
	type EmbeddingProvider,
	type StoredTextChunk,
	type TextEmbedJob,
	type TextEmbedStatus,
} from "../model/text-embed.ts";
import type { EnrichmentService } from "../enrichment/service.ts";
import type { ImageVlmRecord } from "../model/image-vlm.ts";
import type { VideoVlmRecord } from "../model/video-vlm.ts";
import type { AudioWriteupRecord } from "../model/audio-writeup.ts";
import type { MetadataStore } from "../stores/types.ts";
import { canDescribeImage } from "./image-vlm.ts";
import { chunkMarkdown } from "./chunk.ts";
import { canIndexText, textToMarkdown } from "./text-source.ts";
import { canDescribeVideo } from "./video-vlm.ts";
import { canDescribeAudio } from "./audio-writeup.ts";

export interface EmbedOptions {
	/** Rebuild chunks and vectors even when the existing index looks current. */
	force?: boolean;
}

export class TextEmbedService {
	private chain: Promise<void> = Promise.resolve();
	private readonly metadata: MetadataStore;
	private readonly enrichment: EnrichmentService;

	constructor(metadata: MetadataStore, enrichment: EnrichmentService) {
		this.metadata = metadata;
		this.enrichment = enrichment;
	}

	async getStatus(assetId: string, currentModelId?: string): Promise<TextEmbedStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.statusFor(asset, currentModelId);
	}

	async embed(
		assetId: string,
		provider: EmbeddingProvider,
		onUpdate?: (status: TextEmbedStatus) => void,
		signal?: AbortSignal,
		options: EmbedOptions = {},
	): Promise<TextEmbedStatus> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.enqueue(() => {
			signal?.throwIfAborted();
			return this.run(asset, provider, onUpdate, signal, options.force === true);
		});
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async run(
		asset: Asset,
		provider: EmbeddingProvider,
		onUpdate?: (status: TextEmbedStatus) => void,
		signal?: AbortSignal,
		force = false,
	): Promise<TextEmbedStatus> {
		signal?.throwIfAborted();
		const latest = await this.metadata.getAsset(asset.assetId);
		if (!latest) throw new Error("Asset not found");
		asset = latest;
		signal?.throwIfAborted();
		if (!canIndexAsset(asset)) return unsupportedStatus(asset);

		if (!force) {
			const current = await this.currentIfFresh(asset, provider.modelId);
			if (current) return current;
		}

		signal?.throwIfAborted();
		await this.writeJob(asset, {
			status: "embedding",
			modelId: provider.modelId,
			error: undefined,
			childCount: 0,
			parentCount: 0,
		});
		onUpdate?.(await this.statusFor(asset, provider.modelId));

		try {
			const source = await this.sourceMarkdown(asset, signal);
			if ("unsupported" in source) return unsupportedStatus(asset);
			if ("error" in source) {
				await this.writeJob(asset, {
					status: "failed",
					modelId: provider.modelId,
					error: source.error,
					childCount: 0,
					parentCount: 0,
				});
				return this.statusFor(asset, provider.modelId);
			}

			const plan = chunkMarkdown(source.text);
			const chunks = toStoredChunks(asset.assetId, plan);
			const children = chunks.filter((chunk) => chunk.role === "child");
			const pending = children.filter((chunk) => chunk.text.trim().length > 0);
			// Embed first, then swap the whole set in one transaction. A failure or cancel
			// before the swap leaves the previous chunks and vectors exactly as they were.
			if (pending.length > 0) {
				const vectors = await embedBatched(provider, pending.map((chunk) => chunk.text), signal);
				pending.forEach((chunk, index) => {
					chunk.embedding = vectors[index]!;
					chunk.modelId = provider.modelId;
				});
			}
			signal?.throwIfAborted();
			await this.metadata.replaceTextChunks(asset.assetId, chunks);

			signal?.throwIfAborted();
			await this.writeJob(asset, {
				status: "ready",
				modelId: provider.modelId,
				error: undefined,
				childCount: children.length,
				parentCount: plan.parents.length,
			});
			return this.statusFor(asset, provider.modelId);
		} catch (error) {
			await this.writeJob(asset, {
				status: "failed",
				modelId: provider.modelId,
				error: error instanceof Error ? error.message : String(error),
			});
			return this.statusFor(asset, provider.modelId);
		}
	}

	private async ensureExtract(asset: Asset, signal?: AbortSignal) {
		const existing = await this.metadata.getAssetEnrichment(asset.assetId);
		if (
			existing
			&& !isEnrichmentStale(existing, asset.modifiedAt)
			&& existing.status === "ready"
			&& existing.data?.kind === "text"
		) {
			return existing;
		}
		return this.enrichment.analyze(asset.assetId, signal);
	}

	private async sourceMarkdown(asset: Asset, signal?: AbortSignal): Promise<{ text: string } | { error: string } | { unsupported: true }> {
		if (canIndexText(asset.filename)) {
			const extract = await this.ensureExtract(asset, signal);
			if (extract.status !== "ready" || extract.data?.kind !== "text") {
				return { error: extract.error ?? "Level 1 extract is not ready" };
			}
			return { text: textToMarkdown(asset.filename, extract.data.text, extract.data.truncated) };
		}
		const writeup = await this.readyWriteup(asset);
		if (writeup === "missing") {
			if (canDescribeImage(asset)) return { error: "Describe the image with the VLM slot first" };
			if (canDescribeVideo(asset)) return { error: "Describe the video with the VLM slot first" };
			if (canDescribeAudio(asset)) return { error: "Describe the audio with the Audio slot first" };
			return { unsupported: true };
		}
		if (writeup) return { text: writeup.markdown };
		return { unsupported: true };
	}

	private async currentIfFresh(asset: Asset, modelId: string): Promise<TextEmbedStatus | undefined> {
		const job = await this.metadata.getTextEmbedJob(asset.assetId);
		if (job?.status !== "ready" || job.modelId !== modelId || job.sourceModifiedAt !== asset.modifiedAt) {
			return undefined;
		}
		if (needsVlmWriteup(asset)) {
			const record = await this.writeupRecord(asset);
			if (
				record?.status !== "ready"
				|| record.sourceModifiedAt !== asset.modifiedAt
				|| !record.markdown?.trim()
				|| record.updatedAt > job.updatedAt
			) {
				return undefined;
			}
		}
		const chunks = await this.metadata.listTextChunks(asset.assetId);
		const children = chunks.filter((chunk) => chunk.role === "child");
		const missing = children.some((chunk) => (
			chunk.text.trim().length > 0 && (!chunk.embedding || chunk.modelId !== modelId)
		));
		if (missing) return undefined;
		return toStatus(asset, job, modelId, await this.extraStale(asset, job));
	}

	private async writeJob(
		asset: Asset,
		patch: Partial<Pick<TextEmbedJob, "status" | "modelId" | "error" | "childCount" | "parentCount">>,
	): Promise<void> {
		const previous = await this.metadata.getTextEmbedJob(asset.assetId);
		await this.metadata.upsertTextEmbedJob({
			assetId: asset.assetId,
			status: patch.status ?? previous?.status ?? "embedding",
			modelId: patch.modelId ?? previous?.modelId,
			sourceModifiedAt: asset.modifiedAt,
			error: patch.error,
			childCount: patch.childCount ?? previous?.childCount ?? 0,
			parentCount: patch.parentCount ?? previous?.parentCount ?? 0,
			updatedAt: Date.now(),
		});
	}

	private async statusFor(asset: Asset, currentModelId?: string): Promise<TextEmbedStatus> {
		if (!canIndexAsset(asset)) return unsupportedStatus(asset);
		if (needsVlmWriteup(asset)) {
			const record = await this.writeupRecord(asset);
			if (record?.status !== "ready" || !record.markdown?.trim()) return unsupportedStatus(asset);
		}
		const job = await this.metadata.getTextEmbedJob(asset.assetId);
		if (!job) return idleStatus(asset);
		return toStatus(asset, job, currentModelId, await this.extraStale(asset, job));
	}

	private async extraStale(asset: Asset, job: TextEmbedJob): Promise<boolean> {
		if (!needsVlmWriteup(asset)) return false;
		const record = await this.writeupRecord(asset);
		if (!record) return true;
		return record.sourceModifiedAt !== asset.modifiedAt || record.updatedAt > job.updatedAt;
	}

	private async writeupRecord(asset: Asset): Promise<ImageVlmRecord | VideoVlmRecord | AudioWriteupRecord | undefined> {
		if (canDescribeImage(asset)) return this.metadata.getImageVlm(asset.assetId);
		if (canDescribeVideo(asset)) return this.metadata.getVideoVlm(asset.assetId);
		if (canDescribeAudio(asset)) return this.metadata.getAudioWriteup(asset.assetId);
		return undefined;
	}

	private async readyWriteup(
		asset: Asset,
	): Promise<{ markdown: string } | "missing" | undefined> {
		if (!needsVlmWriteup(asset)) return undefined;
		const record = await this.writeupRecord(asset);
		const markdown = record?.status === "ready"
			&& record.sourceModifiedAt === asset.modifiedAt
			? record.markdown?.trim()
			: undefined;
		if (!markdown) return "missing";
		return { markdown };
	}
}

function needsVlmWriteup(asset: Asset): boolean {
	return canDescribeImage(asset) || canDescribeVideo(asset) || canDescribeAudio(asset);
}

function canIndexAsset(asset: Asset): boolean {
	return canIndexText(asset.filename) || needsVlmWriteup(asset);
}

function toStoredChunks(assetId: string, plan: ReturnType<typeof chunkMarkdown>): StoredTextChunk[] {
	const chunks: StoredTextChunk[] = [];
	for (const parent of plan.parents) {
		const parentId = randomUUID();
		chunks.push({
			chunkId: parentId,
			assetId,
			parentId: null,
			role: "parent",
			startOffset: parent.start,
			endOffset: parent.end,
			text: parent.text,
			tokenCount: parent.tokenCount,
		});
		for (const child of parent.children) {
			chunks.push({
				chunkId: randomUUID(),
				assetId,
				parentId,
				role: "child",
				startOffset: child.start,
				endOffset: child.end,
				text: child.text,
				tokenCount: child.tokenCount,
			});
		}
	}
	return chunks;
}

async function embedBatched(
	provider: EmbeddingProvider,
	texts: string[],
	signal?: AbortSignal,
): Promise<number[][]> {
	const vectors: number[][] = [];
	for (let index = 0; index < texts.length; index += EMBED_BATCH_SIZE) {
		if (signal?.aborted) throw new Error("Operation aborted");
		const batch = texts.slice(index, index + EMBED_BATCH_SIZE);
		const part = await abortableProviderCall(() => provider.embed(batch, signal), signal);
		if (part.length !== batch.length) {
			throw new Error("Embedding provider returned the wrong number of vectors");
		}
		vectors.push(...part);
	}
	return vectors;
}

function toStatus(
	asset: Asset,
	job: TextEmbedJob,
	currentModelId?: string,
	extraStale = false,
): TextEmbedStatus {
	const stale = extraStale
		|| job.sourceModifiedAt !== asset.modifiedAt
		|| (currentModelId !== undefined && job.modelId !== undefined && job.modelId !== currentModelId);
	return {
		assetId: asset.assetId,
		status: job.status,
		stale,
		supported: true,
		modelId: job.modelId,
		sourceModifiedAt: job.sourceModifiedAt,
		error: job.error,
		childCount: job.childCount,
		parentCount: job.parentCount,
	};
}

function idleStatus(asset: Asset): TextEmbedStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: true,
		childCount: 0,
		parentCount: 0,
	};
}

function unsupportedStatus(asset: Asset): TextEmbedStatus {
	return {
		assetId: asset.assetId,
		status: "idle",
		stale: false,
		supported: false,
		childCount: 0,
		parentCount: 0,
	};
}
