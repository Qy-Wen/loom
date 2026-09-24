import type { Asset } from "../model/asset.ts";
import {
	ENRICHMENT_VERSION,
	isEnrichmentStale,
	type AssetEnrichment,
} from "../model/enrichment.ts";
import type { MetadataStore } from "../stores/types.ts";
import { extractEnrichment, shouldSkipAsset } from "./extract.ts";

export class EnrichmentService {
	private chain: Promise<void> = Promise.resolve();
	private readonly metadata: MetadataStore;
	private readonly resolvePath: (assetId: string) => Promise<string | undefined>;
	private readonly extract: typeof extractEnrichment;

	constructor(
		metadata: MetadataStore,
		resolvePath: (assetId: string) => Promise<string | undefined>,
		extract: typeof extractEnrichment = extractEnrichment,
	) {
		this.metadata = metadata;
		this.resolvePath = resolvePath;
		this.extract = extract;
	}

	async refreshStale(assets: Asset[]): Promise<AssetEnrichment[]> {
		const records: AssetEnrichment[] = [];
		for (const asset of assets) {
			const existing = await this.metadata.getAssetEnrichment(asset.assetId);
			if (!isEnrichmentStale(existing, asset.modifiedAt)) continue;
			records.push(await this.enqueue(() => this.enrich(asset, false)));
		}
		return records;
	}

	async analyze(assetId: string): Promise<AssetEnrichment> {
		const asset = await this.metadata.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return this.enqueue(() => this.enrich(asset, true));
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(work, work);
		this.chain = run.then(() => undefined, () => undefined);
		return run;
	}

	private async enrich(asset: Asset, force: boolean): Promise<AssetEnrichment> {
		if (!force) {
			const existing = await this.metadata.getAssetEnrichment(asset.assetId);
			if (existing && !isEnrichmentStale(existing, asset.modifiedAt)) return existing;
		}

		const skip = shouldSkipAsset(asset);
		if (skip) {
			const record: AssetEnrichment = {
				assetId: asset.assetId,
				version: ENRICHMENT_VERSION,
				sourceModifiedAt: asset.modifiedAt,
				status: "skipped",
				error: skip,
			};
			await this.metadata.upsertAssetEnrichment(record);
			return record;
		}

		const absolutePath = await this.resolvePath(asset.assetId);
		if (!absolutePath) throw new Error("Asset not found");

		try {
			const data = await this.extract(absolutePath, asset.type, asset.filename);
			const record: AssetEnrichment = {
				assetId: asset.assetId,
				version: ENRICHMENT_VERSION,
				sourceModifiedAt: asset.modifiedAt,
				status: "ready",
				data,
			};
			await this.metadata.upsertAssetEnrichment(record);
			return record;
		} catch (error) {
			const record: AssetEnrichment = {
				assetId: asset.assetId,
				version: ENRICHMENT_VERSION,
				sourceModifiedAt: asset.modifiedAt,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
			await this.metadata.upsertAssetEnrichment(record);
			return record;
		}
	}
}
