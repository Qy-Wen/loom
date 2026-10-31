import type { AppTheme } from "./general-settings.ts";

/**
 * Colors the main process paints itself: the window background before the page loads and the Windows title-bar
 * buttons. They mirror `--lm-surface-subtle`, `--lm-surface-window` and `--lm-text-primary` in
 * renderer/design/tokens.css; tests/design-tokens.test.ts fails if they drift apart.
 */
export const WINDOW_COLORS: Record<AppTheme, { background: string; titleBar: string; titleBarSymbol: string }> = {
	light: { background: "#f7f7f5", titleBar: "#f3f3f1", titleBarSymbol: "#202124" },
	dark: { background: "#181817", titleBar: "#141413", titleBarSymbol: "#ecece9" },
};
