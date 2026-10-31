/**
 * Mirror the resolved light/dark theme onto <html>.
 *
 * The stylesheet switches on `prefers-color-scheme`, which the main process drives through `nativeTheme.themeSource`.
 * `data-theme` and the `dark` class exist for code that cannot read a media query: CopilotKit's stylesheet looks for a
 * `.dark` ancestor, and tests read `data-theme`. Returns a function that stops listening.
 */
export function followColorScheme(root: HTMLElement = document.documentElement): () => void {
	const query = window.matchMedia("(prefers-color-scheme: dark)");
	const apply = () => {
		const theme = query.matches ? "dark" : "light";
		root.dataset.theme = theme;
		root.classList.toggle("dark", theme === "dark");
	};
	apply();
	query.addEventListener("change", apply);
	return () => query.removeEventListener("change", apply);
}

/** Re-run `listener` whenever the theme flips. For canvas code, which cannot repaint itself through CSS. */
export function onThemeChange(listener: () => void): () => void {
	const query = window.matchMedia("(prefers-color-scheme: dark)");
	query.addEventListener("change", listener);
	return () => query.removeEventListener("change", listener);
}
