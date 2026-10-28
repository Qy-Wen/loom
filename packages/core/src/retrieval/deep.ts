import type { ChunkHit } from "../model/hybrid.ts";
import { HYBRID_CANDIDATES, rrfFuse, uniqueInOrder } from "./rrf.ts";

/** A chunk after fusion: the hit plus the fused score. */
export interface FusedChunk {
	hit: ChunkHit;
	score: number;
}

/**
 * Fuse full-text and vector chunk hits into one ranked list of chunks.
 *
 * Both inputs are chunk lists, best first. A chunk found by both paths scores
 * from both. Chunks of files that fail `passes` (type and property filters) are
 * dropped before fusion so a filtered-out file cannot take a candidate slot.
 */
export function fuseChunks(
	fullText: readonly ChunkHit[],
	vector: readonly ChunkHit[],
	passes: (assetId: string) => boolean,
): FusedChunk[] {
	const byId = new Map<string, ChunkHit>();
	const lists: string[][] = [];
	for (const hits of [fullText, vector]) {
		const ids: string[] = [];
		for (const hit of hits) {
			if (!passes(hit.assetId)) continue;
			if (!byId.has(hit.chunkId)) byId.set(hit.chunkId, hit);
			ids.push(hit.chunkId);
		}
		lists.push(uniqueInOrder(ids).slice(0, HYBRID_CANDIDATES));
	}
	const fused: FusedChunk[] = [];
	for (const { id, score } of rrfFuse(lists)) {
		const hit = byId.get(id);
		if (hit) fused.push({ hit, score });
	}
	return fused;
}

/** Keep each file's best chunk, in the order chunks arrive. */
export function bestChunkPerFile<T extends { hit: ChunkHit }>(ranked: readonly T[]): T[] {
	const seen = new Set<string>();
	const best: T[] = [];
	for (const item of ranked) {
		if (seen.has(item.hit.assetId)) continue;
		seen.add(item.hit.assetId);
		best.push(item);
	}
	return best;
}
