import { useEffect, useState } from "react";

export const BROWSER_ICON_SIZE = { min: 80, max: 240, step: 16, default: 112 } as const;
const STORAGE_KEY = "loom.browser.iconSize";

/** Bound and snap preferences so the slider, buttons, and grid always agree. */
export function normalizeBrowserIconSize(value: number): number {
	if (!Number.isFinite(value)) return BROWSER_ICON_SIZE.default;
	const { min, max, step } = BROWSER_ICON_SIZE;
	return Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step));
}

export function useBrowserIconSize(): [number, (value: number) => void] {
	const [size, setSize] = useState(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			return stored?.trim() ? normalizeBrowserIconSize(Number(stored)) : BROWSER_ICON_SIZE.default;
		} catch {
			return BROWSER_ICON_SIZE.default;
		}
	});
	useEffect(() => {
		try { localStorage.setItem(STORAGE_KEY, String(size)); } catch { /* Display preferences are optional. */ }
	}, [size]);
	return [size, (value) => setSize(normalizeBrowserIconSize(value))];
}
