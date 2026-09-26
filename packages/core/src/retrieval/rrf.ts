/** Reciprocal Rank Fusion constant from Cormack et al. Rank is 1-based. */
export const RRF_K = 60;

/** How many hits to take from FTS and from sqlite-vec before fusion. */
export const HYBRID_CANDIDATES = 50;

export interface RankedId {
	id: string;
	score: number;
}

/** Fuse ranked id lists. A hit in only one list still scores from that list. */
export function rrfFuse(lists: string[][], k = RRF_K): RankedId[] {
	const scores = new Map<string, number>();
	for (const list of lists) {
		list.forEach((id, index) => {
			scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
		});
	}
	return [...scores.entries()]
		.map(([id, score]) => ({ id, score }))
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function cosineDistance(left: number[], right: number[]): number {
	if (left.length === 0 || left.length !== right.length) return Number.POSITIVE_INFINITY;
	let dot = 0;
	let leftNorm = 0;
	let rightNorm = 0;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index]!;
		const b = right[index]!;
		dot += a * b;
		leftNorm += a * a;
		rightNorm += b * b;
	}
	const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
	if (denom === 0) return 1;
	return 1 - dot / denom;
}

export function uniqueInOrder(ids: string[]): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		ordered.push(id);
	}
	return ordered;
}
