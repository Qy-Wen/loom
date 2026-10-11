import type { Asset } from "../model/asset.ts";
import type { NearestChildHit } from "../model/hybrid.ts";
import { toSearchItem, type AssetPropertyView, type AssetSearchItem, type SearchLink } from "../model/retrieval.ts";
import type { AssetRelation } from "../stores/types.ts";

/** One-hop neighbors added per search candidate, before rerank. */
export const SEARCH_NEIGHBORS_PER_SEED = 8;

interface Touch {
	neighborId: string;
	relationType: string;
	direction: SearchLink["direction"];
}

/**
 * Append one relation hop from each seed. A neighbor already in the list stays a seed.
 * Type and property filters are the caller's job and are not applied here.
 */
export function expandSearchCandidates(
	seeds: readonly AssetSearchItem[],
	relations: readonly AssetRelation[],
	assetsById: ReadonlyMap<string, Asset>,
	propertiesByAsset: ReadonlyMap<string, readonly AssetPropertyView[]>,
	passages: ReadonlyMap<string, NearestChildHit>,
): AssetSearchItem[] {
	if (seeds.length === 0 || relations.length === 0) return [...seeds];
	const touches = indexTouches(relations);
	const seen = new Set(seeds.map((seed) => seed.assetId));
	const expanded = [...seeds];
	for (const seed of seeds) {
		const ranked = rankNeighbors(touches.get(seed.assetId) ?? [], seen, assetsById);
		for (const touch of ranked.slice(0, SEARCH_NEIGHBORS_PER_SEED)) {
			const asset = assetsById.get(touch.neighborId);
			if (!asset) continue;
			seen.add(touch.neighborId);
			const child = passages.get(touch.neighborId);
			expanded.push({
				...toSearchItem(asset, [...(propertiesByAsset.get(touch.neighborId) ?? [])]),
				...(child
					? { passage: child.text, parentPassage: child.parentText, chunkId: child.chunkId }
					: {}),
				linkedFrom: {
					assetId: seed.assetId,
					relationType: touch.relationType,
					direction: touch.direction,
				},
			});
		}
	}
	return expanded;
}

function indexTouches(relations: readonly AssetRelation[]): Map<string, Touch[]> {
	const touches = new Map<string, Touch[]>();
	const add = (assetId: string, touch: Touch) => {
		const list = touches.get(assetId);
		if (list) list.push(touch);
		else touches.set(assetId, [touch]);
	};
	for (const relation of relations) {
		if (relation.fromAssetId === relation.toAssetId) continue;
		add(relation.fromAssetId, {
			neighborId: relation.toAssetId,
			relationType: relation.type,
			direction: "out",
		});
		add(relation.toAssetId, {
			neighborId: relation.fromAssetId,
			relationType: relation.type,
			direction: "in",
		});
	}
	return touches;
}

/** One edge per neighbor. Earlier relation type, then direction, then path. */
function rankNeighbors(
	touches: readonly Touch[],
	seen: ReadonlySet<string>,
	assetsById: ReadonlyMap<string, Asset>,
): Touch[] {
	const best = new Map<string, Touch>();
	for (const touch of touches) {
		if (seen.has(touch.neighborId) || !assetsById.has(touch.neighborId)) continue;
		const current = best.get(touch.neighborId);
		if (!current || compareTouch(touch, current, assetsById) < 0) best.set(touch.neighborId, touch);
	}
	return [...best.values()].sort((left, right) => compareTouch(left, right, assetsById));
}

function compareTouch(left: Touch, right: Touch, assetsById: ReadonlyMap<string, Asset>): number {
	return left.relationType.localeCompare(right.relationType)
		|| left.direction.localeCompare(right.direction)
		|| pathOf(assetsById, left.neighborId).localeCompare(pathOf(assetsById, right.neighborId));
}

function pathOf(assetsById: ReadonlyMap<string, Asset>, assetId: string): string {
	return assetsById.get(assetId)?.relativePath ?? "";
}
