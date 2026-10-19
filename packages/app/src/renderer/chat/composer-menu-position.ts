/** Prefer above the composer; history editors near the top can open below instead. */
export function composerMenuPosition(anchor: HTMLElement, menu: HTMLElement): { left: number; top: number } {
	const rect = anchor.getBoundingClientRect();
	const above = rect.top - menu.offsetHeight - 6;
	return {
		left: Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)),
		top: Math.max(8, Math.min(above >= 8 ? above : rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)),
	};
}
