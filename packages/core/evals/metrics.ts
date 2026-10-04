/** Binary relevance metrics over ranked relative paths. */

export function recallAtK(ranked: string[], relevant: string[], k: number): number {
	if (relevant.length === 0) return 1;
	const top = new Set(ranked.slice(0, k));
	let hits = 0;
	for (const path of relevant) if (top.has(path)) hits++;
	return hits / relevant.length;
}

export function ndcgAtK(ranked: string[], relevant: string[], k: number): number {
	if (relevant.length === 0) return 1;
	const gold = new Set(relevant);
	const dcg = dcgAtK(ranked, gold, k);
	const ideal = dcgAtK([...relevant, ...ranked.filter((path) => !gold.has(path))], gold, k);
	return ideal === 0 ? 0 : dcg / ideal;
}

function dcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
	let total = 0;
	for (let index = 0; index < Math.min(k, ranked.length); index++) {
		if (!relevant.has(ranked[index]!)) continue;
		total += 1 / Math.log2(index + 2);
	}
	return total;
}

export function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}
