import type { Asset } from "../model/asset.ts";
import type { DescriptionRecord, DescriptionStatus } from "../model/description.ts";

interface DescriptionWorkflow<Provider extends { modelId: string }> {
	getAsset(assetId: string): Promise<Asset | undefined>;
	getRecord(assetId: string): Promise<DescriptionRecord | undefined>;
	writeRecord(record: DescriptionRecord): Promise<void>;
	supports(asset: Asset): boolean;
	generate(asset: Asset, provider: Provider, signal?: AbortSignal): Promise<string>;
}

/** One serial queue per media service; the caller's library scope owns cancellation and draining. */
export class DescriptionService<Provider extends { modelId: string }> {
	private chain: Promise<void> = Promise.resolve();
	private readonly workflow: DescriptionWorkflow<Provider>;

	constructor(workflow: DescriptionWorkflow<Provider>) {
		this.workflow = workflow;
	}

	async getStatus(assetId: string, currentModelId?: string): Promise<DescriptionStatus> {
		const asset = await this.requireAsset(assetId);
		return this.statusFor(asset, currentModelId);
	}

	async describe(
		assetId: string,
		provider: Provider,
		onUpdate?: (status: DescriptionStatus) => void,
		signal?: AbortSignal,
	): Promise<DescriptionStatus> {
		signal?.throwIfAborted();
		await this.requireAsset(assetId);
		const work = () => this.run(assetId, provider, onUpdate, signal);
		const run = this.chain.then(work, work);
		this.chain = run.then(() => undefined, () => undefined);
		const status = await run;
		onUpdate?.(status);
		return status;
	}

	private async run(
		assetId: string,
		provider: Provider,
		onUpdate?: (status: DescriptionStatus) => void,
		signal?: AbortSignal,
	): Promise<DescriptionStatus> {
		signal?.throwIfAborted();
		// A queued asset may have changed or disappeared since admission.
		const asset = await this.requireAsset(assetId);
		signal?.throwIfAborted();
		if (!this.workflow.supports(asset)) return idleStatus(asset, false);

		const previous = await this.workflow.getRecord(assetId);
		if (previous?.status === "ready" && previous.modelId === provider.modelId
			&& previous.markdown?.trim() && !isStale(asset, previous, provider.modelId)) {
			return toStatus(asset, previous, provider.modelId);
		}

		signal?.throwIfAborted();
		const record: DescriptionRecord = {
			assetId,
			status: "describing",
			modelId: provider.modelId,
			sourceModifiedAt: asset.modifiedAt,
			markdown: previous?.markdown,
			updatedAt: Date.now(),
		};
		await this.workflow.writeRecord(record);
		onUpdate?.(toStatus(asset, record, provider.modelId));

		try {
			const markdown = await this.workflow.generate(asset, provider, signal);
			signal?.throwIfAborted();
			await this.workflow.writeRecord({ ...record, status: "ready", markdown, updatedAt: Date.now() });
		} catch (error) {
			// The library scope keeps storage open until this terminal write finishes, including on abort.
			await this.workflow.writeRecord({
				...record,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				markdown: undefined,
				updatedAt: Date.now(),
			});
		}
		return this.statusFor(asset, provider.modelId);
	}

	private async requireAsset(assetId: string): Promise<Asset> {
		const asset = await this.workflow.getAsset(assetId);
		if (!asset) throw new Error("Asset not found");
		return asset;
	}

	private async statusFor(asset: Asset, currentModelId?: string): Promise<DescriptionStatus> {
		if (!this.workflow.supports(asset)) return idleStatus(asset, false);
		const record = await this.workflow.getRecord(asset.assetId);
		return record ? toStatus(asset, record, currentModelId) : idleStatus(asset, true);
	}
}

function isStale(asset: Asset, record: DescriptionRecord, currentModelId?: string): boolean {
	return record.sourceModifiedAt !== asset.modifiedAt
		|| (currentModelId !== undefined && record.modelId !== undefined && record.modelId !== currentModelId);
}

function toStatus(asset: Asset, record: DescriptionRecord, currentModelId?: string): DescriptionStatus {
	return {
		assetId: asset.assetId,
		status: record.status,
		stale: isStale(asset, record, currentModelId),
		supported: true,
		modelId: record.modelId,
		sourceModifiedAt: record.sourceModifiedAt,
		error: record.error,
		markdown: record.markdown,
	};
}

function idleStatus(asset: Asset, supported: boolean): DescriptionStatus {
	return { assetId: asset.assetId, status: "idle", stale: false, supported };
}
