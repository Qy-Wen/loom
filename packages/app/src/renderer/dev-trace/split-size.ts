export const TRACE_SPLIT_HANDLE = 6;

/** Preferred minima yield proportionally when a resized window cannot fit both panes. */
export function splitBounds(extent: number, minFirst: number, minSecond: number): { min: number; max: number } {
	const available = Math.max(0, extent);
	const scale = Math.min(1, available / (minFirst + minSecond || 1));
	return { min: minFirst * scale, max: available - minSecond * scale };
}

export function splitSize(preferred: number, extent: number, minFirst: number, minSecond: number): number {
	const { min, max } = splitBounds(extent, minFirst, minSecond);
	return Math.min(max, Math.max(min, preferred));
}

export function readSplitSize(storage: Pick<Storage, "getItem">, key: string, fallback: number): number {
	try {
		const raw = storage.getItem(key);
		const value = raw === null ? NaN : Number(raw);
		return Number.isFinite(value) && value >= 0 ? value : fallback;
	} catch { return fallback; }
}
