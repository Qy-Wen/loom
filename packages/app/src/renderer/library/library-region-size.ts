export const LIBRARY_REGION_HANDLE = 12;
export const DEFAULT_SHORTCUT_FRACTION = 0.4;

/** Content-sized upper pane with a preferred cap; both minima yield proportionally in short windows. */
export function libraryRegionSize(height: number, content: number, fraction: number): { size: number; min: number; max: number; extent: number } {
	const extent = Math.max(0, height - LIBRARY_REGION_HANDLE);
	const topMinimum = Math.min(64, Math.max(0, content));
	const scale = Math.min(1, extent / (topMinimum + 120));
	const min = topMinimum * scale;
	const max = Math.min(Math.max(0, content), Math.max(min, extent - 120 * scale));
	return { size: Math.min(max, Math.max(min, fraction * extent)), min, max, extent };
}
