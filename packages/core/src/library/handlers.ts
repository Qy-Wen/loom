import type { Asset } from "../model/asset.ts";
import type { GraphStore, MetadataStore } from "../stores/types.ts";

export type LibrarySituation =
	| { type: "added"; asset: Asset }
	| { type: "removed"; asset: Asset }
	| { type: "moved"; asset: Asset; previousPath: string }
	| { type: "updated"; asset: Asset; previous: Asset };

/** Graph-side reactions to library situations. */
export interface GraphHandlers {
	handleAdded(asset: Asset): Promise<void>;
	handleRemoved(asset: Asset): Promise<void>;
	handleMoved(asset: Asset, previousPath: string): Promise<void>;
	handleUpdated(asset: Asset, previous: Asset): Promise<void>;
}

export class NoopGraphHandlers implements GraphHandlers {
	async handleAdded(): Promise<void> {}
	async handleRemoved(): Promise<void> {}
	async handleMoved(): Promise<void> {}
	async handleUpdated(): Promise<void> {}
}

/** Keeps graph nodes in sync with library add/remove. Path changes stay on SQLite. */
export class StoreGraphHandlers implements GraphHandlers {
	private readonly graph: GraphStore;

	constructor(graph: GraphStore) {
		this.graph = graph;
	}

	handleAdded(asset: Asset): Promise<void> {
		return this.graph.ensureAsset(asset.assetId);
	}

	handleRemoved(asset: Asset): Promise<void> {
		return this.graph.removeAsset(asset.assetId);
	}

	async handleMoved(): Promise<void> {}

	async handleUpdated(): Promise<void> {}
}

export function diffLibraryAssets(previous: Asset[], next: Asset[]): LibrarySituation[] {
	const previousById = new Map(previous.map((asset) => [asset.assetId, asset]));
	const nextIds = new Set(next.map((asset) => asset.assetId));
	const situations: LibrarySituation[] = [];

	for (const asset of previous) {
		if (!nextIds.has(asset.assetId)) situations.push({ type: "removed", asset });
	}
	for (const asset of next) {
		const prior = previousById.get(asset.assetId);
		if (!prior) {
			situations.push({ type: "added", asset });
			continue;
		}
		if (prior.relativePath !== asset.relativePath) {
			situations.push({ type: "moved", asset, previousPath: prior.relativePath });
			continue;
		}
		if (
			prior.fileSystemId !== asset.fileSystemId ||
			prior.size !== asset.size ||
			prior.modifiedAt !== asset.modifiedAt ||
			prior.filename !== asset.filename ||
			prior.type !== asset.type
		) {
			situations.push({ type: "updated", asset, previous: prior });
		}
	}

	return situations;
}

/**
 * After Library identifies a situation, persist it to metadata and the graph.
 * Open-reconcile writes metadata as one replace so path swaps cannot collide.
 */
export class LibraryHandlers {
	readonly metadata: MetadataStore;
	private readonly graph: GraphHandlers;

	constructor(metadata: MetadataStore, graph: GraphHandlers) {
		this.metadata = metadata;
		this.graph = graph;
	}

	async applyOpenReconcile(previous: Asset[], next: Asset[]): Promise<void> {
		await this.metadata.replaceAssets(next);
		await this.dispatch(diffLibraryAssets(previous, next));
	}

	async upsertAsset(asset: Asset): Promise<void> {
		const previous = await this.metadata.getAsset(asset.assetId);
		const occupant = await this.metadata.getAssetByPath(asset.relativePath);
		await this.metadata.upsertAsset(asset);

		const situations: LibrarySituation[] = [];
		if (occupant && occupant.assetId !== asset.assetId) {
			situations.push({ type: "removed", asset: occupant });
		}
		if (!previous) situations.push({ type: "added", asset });
		else if (previous.relativePath !== asset.relativePath) {
			situations.push({ type: "moved", asset, previousPath: previous.relativePath });
		} else {
			situations.push({ type: "updated", asset, previous });
		}
		await this.dispatch(situations);
	}

	async removeAsset(asset: Asset): Promise<void> {
		await this.metadata.removeAsset(asset.assetId);
		await this.dispatch([{ type: "removed", asset }]);
	}

	private async dispatch(situations: LibrarySituation[]): Promise<void> {
		for (const situation of situations) {
			if (situation.type === "removed") await this.graph.handleRemoved(situation.asset);
			else if (situation.type === "moved") await this.graph.handleMoved(situation.asset, situation.previousPath);
			else if (situation.type === "updated") await this.graph.handleUpdated(situation.asset, situation.previous);
			else await this.graph.handleAdded(situation.asset);
		}
	}
}
