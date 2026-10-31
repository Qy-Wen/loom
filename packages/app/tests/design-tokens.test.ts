import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

/**
 * The renderer's visual language lives in src/renderer/design/tokens.css. Components must use its
 * tokens (`var(--lm-…)`) instead of repeating raw values, so a theme or a scale change is one edit.
 * See docs/DESIGN.md.
 */
const renderer = join(import.meta.dirname, "../src/renderer");
const tokensFile = join(renderer, "design/tokens.css");

function files(dir: string, ext: RegExp): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return files(path, ext);
		return ext.test(entry.name) ? [path] : [];
	});
}

/** Source with comments removed and every line numbered. */
function lines(path: string): { n: number; text: string }[] {
	const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
	return source.split("\n").map((text, i) => ({ n: i + 1, text }));
}

function violations(ext: RegExp, test: (text: string) => string | null): string[] {
	const found: string[] = [];
	for (const path of files(renderer, ext)) {
		if (path === tokensFile) continue;
		for (const { n, text } of lines(path)) {
			const reason = test(text);
			if (reason) found.push(`${relative(renderer, path)}:${n}  ${reason}  →  ${text.trim().slice(0, 90)}`);
		}
	}
	return found;
}

const css = /\.css$/;
const rawColor = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/;
const custom = (text: string) => /^\s*--/.test(text);

describe("design tokens", () => {
	it("defines every token that components reference", () => {
		const tokens = readFileSync(tokensFile, "utf8");
		const defined = new Set([...tokens.matchAll(/^\s*(--lm-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
		const missing: string[] = [];
		for (const path of files(renderer, /\.(css|tsx?)$/)) {
			if (path === tokensFile) continue;
			for (const { n, text } of lines(path)) {
				for (const m of text.matchAll(/var\((--lm-[a-z0-9-]+)/g)) if (!defined.has(m[1]!)) missing.push(`${relative(renderer, path)}:${n}  ${m[1]}`);
			}
		}
		assert.deepEqual(missing, [], `Undefined design tokens:\n${missing.join("\n")}`);
	});

	it("keeps raw colors in tokens.css only", () => {
		const found = violations(css, (text) => (rawColor.test(text) && !/^\s*@import/.test(text) ? "raw color" : null));
		assert.deepEqual(found, [], `Use a color token from design/tokens.css:\n${found.join("\n")}`);
	});

	it("keeps raw colors out of TypeScript", () => {
		const found = violations(/\.tsx?$/, (text) => (/["'`]#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/.test(text) ? "raw color" : null));
		assert.deepEqual(found, [], `Use var(--lm-…) or token() from design/tokens.ts:\n${found.join("\n")}`);
	});

	it("uses the radius, type, weight and stacking scales", () => {
		const found = violations(css, (text) => {
			if (custom(text)) return null;
			if (/(?<![\w-])border-radius\s*:\s*[^;}]*\b[1-9]\d*px\b/.test(text)) return "raw border-radius";
			if (/(?<![\w-])font-size\s*:\s*[\d.]+px/.test(text)) return "raw font-size";
			if (/(?<![\w-])font-weight\s*:\s*(?:\d+|bold|normal)\s*[;}]/.test(text)) return "raw font-weight";
			if (/(?<![\w-])z-index\s*:\s*-?\d/.test(text)) return "raw z-index";
			return null;
		});
		assert.deepEqual(found, [], `Use --lm-radius-*, --lm-text-size-*, --lm-weight-* and --lm-z-*:\n${found.join("\n")}`);
	});

	it("uses the spacing scale for padding, margin and gap", () => {
		const scale = new Set(["2px", "4px", "6px", "8px", "10px", "12px", "16px", "20px", "24px"]);
		const found = violations(css, (text) => {
			if (custom(text)) return null;
			for (const m of text.matchAll(/(?<![\w-])(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:\s*([^;}{]+)/g)) {
				if (m[1]!.includes("(")) continue;
				if (m[1]!.split(/\s+/).some((part) => scale.has(part))) return "raw spacing; use --lm-space-*";
			}
			return null;
		});
		assert.deepEqual(found, [], `A value on the spacing scale must use its token:\n${found.join("\n")}`);
	});

	it("uses the motion tokens for transition durations", () => {
		const found = violations(css, (text) => {
			if (custom(text)) return null;
			return /(?<![\w-])transition(?:-duration)?\s*:[^;}]*\b(?:80|100|120|140|200|280)ms\b/.test(text) || /(?<![\w-])transition[^;}]*\b0\.1[25]s\b/.test(text)
				? "raw duration; use --lm-dur-*" : null;
		});
		assert.deepEqual(found, [], `Use --lm-dur-* from design/tokens.css:\n${found.join("\n")}`);
	});
});
