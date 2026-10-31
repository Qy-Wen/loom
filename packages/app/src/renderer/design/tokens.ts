/**
 * Read a design token's computed value for APIs that cannot use `var()` (canvas, WebGL).
 * Pass the name without the `--lm-` prefix: `token("text-primary")`.
 * CSS, SVG attributes and inline styles should use `var(--lm-…)` directly instead.
 */
export function token(name: string, root: HTMLElement = document.documentElement): string {
	return getComputedStyle(root).getPropertyValue(`--lm-${name}`).trim();
}
