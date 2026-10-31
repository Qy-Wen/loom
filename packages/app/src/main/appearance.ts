import { BrowserWindow, nativeTheme } from "electron";
import { resolveAppTheme, type AppAppearanceChoice, type AppTheme } from "../shared/general-settings.ts";
import { WINDOW_COLORS } from "../shared/theme-colors.ts";

export function currentTheme(): AppTheme {
	return resolveAppTheme("system", nativeTheme.shouldUseDarkColors);
}

export function windowColors(): (typeof WINDOW_COLORS)[AppTheme] {
	return WINDOW_COLORS[currentTheme()];
}

function repaintWindowChrome(): void {
	const colors = windowColors();
	for (const window of BrowserWindow.getAllWindows()) {
		if (window.isDestroyed()) continue;
		window.setBackgroundColor(colors.background);
		// Only Windows draws its own caption buttons over the page (see createWindow).
		if (process.platform === "win32") window.setTitleBarOverlay({ color: colors.titleBar, symbolColor: colors.titleBarSymbol });
	}
}

/**
 * Make every window light or dark. `themeSource` also drives `prefers-color-scheme` in each renderer, which is how the
 * stylesheet switches, so no window needs to be told separately.
 */
export function applyAppearance(choice: AppAppearanceChoice): void {
	nativeTheme.themeSource = choice;
	repaintWindowChrome();
}

/** Keep the native chrome in step when the OS flips while the choice is "system". */
export function watchSystemTheme(): void {
	nativeTheme.on("updated", repaintWindowChrome);
}
