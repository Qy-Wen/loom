import katex from "katex";
import texmath from "markdown-it-texmath";

/** The formula syntaxes Loom reads. The preview and the editor both take this list, so they agree. */
export const MATH_DELIMITERS = ["dollars", "brackets"];
export const KATEX_OPTIONS = { throwOnError: false } as const;

// The same rule objects `markdown-it-texmath` runs in the preview, so the editor accepts exactly what it accepts.
const rules = texmath.mergeDelimiters(MATH_DELIMITERS);

export interface MathMatch {
	/** Offset just past the formula, delimiters included. */
	end: number;
	tex: string;
	display: boolean;
}

function matchAt(rule: (typeof rules.inline)[number], str: string, position: number): { end: number; tex: string } | null {
	rule.rex.lastIndex = position;
	if (!str.startsWith(rule.tag, position)) return null;
	if (rule.pre && !rule.pre(str, !!rule.outerSpace, position)) return null;
	const match = rule.rex.exec(str);
	if (!match || rule.rex.lastIndex <= position) return null;
	if (rule.post && !rule.post(str, !!rule.outerSpace, rule.rex.lastIndex - 1)) return null;
	return { end: rule.rex.lastIndex, tex: match[1] };
}

/** An inline formula (`$x$`, `$$x$$`, `\(x\)`) that starts at `position` of `text`. */
export function matchInlineMath(text: string, position: number): MathMatch | null {
	for (const rule of rules.inline) {
		const found = matchAt(rule, text, position);
		if (found) return { ...found, display: !!rule.displayMode };
	}
	return null;
}

/** A formula block (`$$ … $$`, `\[ … \]`) that starts at the beginning of `text`, which may span lines. */
export function matchBlockMath(text: string): MathMatch | null {
	for (const rule of rules.block) {
		if (rule.name !== "math_block") continue;
		const found = matchAt(rule, text, 0);
		if (found) return { ...found, display: true };
	}
	return null;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** KaTeX's HTML for a formula. A formula it cannot read comes back as visible text, never as an exception. */
export function renderMath(tex: string, display: boolean): string {
	try {
		return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });
	} catch (error) {
		return escapeHtml(`${tex}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
