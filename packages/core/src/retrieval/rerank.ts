/** Reorder hits by rerank scores (higher first). Ties keep the original index. */
export function rerankHits<T>(items: T[], scores: number[]): Array<T & { score: number }> {
	return items
		.map((item, index) => ({
			item,
			score: scores[index] ?? Number.NEGATIVE_INFINITY,
			index,
		}))
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map(({ item, score }) => ({ ...item, score }));
}
