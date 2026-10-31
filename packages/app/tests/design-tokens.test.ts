import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { WINDOW_COLORS } from "../src/shared/theme-colors.ts";

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

	it("uses the control size scale for square hit areas and icon slots", () => {
		const scale = new Set(["16px", "20px", "24px", "28px", "32px", "36px", "40px"]);
		// Thin marks, sub-pixel internals and layout bands keep literal geometry; list them here with a reason.
		const exempt = /settings-switch-ui|library-shortcuts-more|trace-turn-header|trace-event-table|trace-history|trace-toolbar|trace-lane-labels/;
		const found: string[] = [];
		for (const path of files(renderer, css)) {
			if (path === tokensFile) continue;
			const source = lines(path).map((l) => l.text).join("\n");
			for (const rule of source.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
				const selector = rule[1]!.trim(), body = rule[2]!;
				if (exempt.test(selector)) continue;
				const hit = [...body.matchAll(/(?<![\w-])(?:min-|max-)?(?:width|height)\s*:\s*(\d+px)\s*(?:!important)?\s*(?=;|$)/g)].find((d) => scale.has(d[1]!))
					?? [...body.matchAll(/(?<![\w-])flex\s*:\s*0 0 (\d+px)/g)].find((d) => scale.has(d[1]!));
				if (!hit) continue;
				const line = source.slice(0, (rule.index ?? 0) + rule[0].indexOf(hit[0])).split("\n").length;
				found.push(`${relative(renderer, path)}:${line}  raw size; use --lm-size-*  →  ${selector.split("\n").pop()!.trim().slice(0, 50)} { ${hit[0].trim()} }`);
			}
		}
		assert.deepEqual(found, [], `A size on the control scale must use its token:\n${found.join("\n")}`);
	});

	it("uses the motion tokens for transition durations", () => {
		const found = violations(css, (text) => {
			if (custom(text)) return null;
			return /(?<![\w-])transition(?:-duration)?\s*:[^;}]*\b(?:80|100|120|140|200|280)ms\b/.test(text) || /(?<![\w-])transition[^;}]*\b0\.1[25]s\b/.test(text)
				? "raw duration; use --lm-dur-*" : null;
		});
		assert.deepEqual(found, [], `Use --lm-dur-* from design/tokens.css:\n${found.join("\n")}`);
	});

	describe("themes", () => {
		const source = readFileSync(tokensFile, "utf8");
		const darkStart = source.indexOf("@media (prefers-color-scheme: dark)");
		const light = source.slice(source.indexOf(":root"), darkStart);
		const dark = source.slice(darkStart);
		const declarations = (block: string) => new Map([...block.matchAll(/^\s*(--lm-[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]));
		const lightTokens = declarations(light), darkTokens = declarations(dark);
		const lookup = (name: string, theme: "light" | "dark"): string => {
			let value = (theme === "dark" ? darkTokens.get(name) : undefined) ?? lightTokens.get(name);
			for (let hops = 0; hops < 6 && value; hops++) {
				const ref = /^var\((--lm-[\w-]+)\)$/.exec(value);
				if (!ref) return value;
				value = (theme === "dark" ? darkTokens.get(ref[1]!) : undefined) ?? lightTokens.get(ref[1]!);
			}
			throw new Error(`${name} does not resolve to a value`);
		};
		const luminance = (hex: string) => {
			const h = hex.slice(1).length === 3 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
			const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
			return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
		};
		const ratio = (a: string, b: string, theme: "light" | "dark") => {
			const [hi, lo] = [luminance(lookup(a, theme)), luminance(lookup(b, theme))].sort((x, y) => y - x);
			return (hi! + 0.05) / (lo! + 0.05);
		};
		const surfaces = ["app", "raised", "subtle", "window", "sunken", "hover", "active"].map((s) => `--lm-surface-${s}`);
		const check = (theme: "light" | "dark", names: string[], backgrounds: string[], minimum: number) => {
			const low = names.flatMap((fg) => backgrounds.map((bg) => ({ fg, bg, value: ratio(fg, bg, theme) }))).filter((row) => row.value < minimum);
			assert.deepEqual(low.map((row) => `${row.fg} on ${row.bg}: ${row.value.toFixed(2)}`), [], `${theme} needs ${minimum}:1`);
		};
		const text = ["primary", "body", "secondary", "muted", "accent", "danger", "warning", "success"].map((n) => `--lm-text-${n}`);

		it("re-maps only tokens the light theme defines", () => {
			const unknown = [...darkTokens.keys()].filter((name) => !lightTokens.has(name));
			assert.deepEqual(unknown, [], "a dark override needs a light value too, or light mode loses it");
		});
		it("keeps the page surfaces and text of both themes distinct", () => {
			assert.notEqual(lookup("--lm-surface-app", "light"), lookup("--lm-surface-app", "dark"));
			assert.notEqual(lookup("--lm-text-primary", "light"), lookup("--lm-text-primary", "dark"));
		});

		for (const theme of ["light", "dark"] as const) {
			describe(`contrast · ${theme}`, () => {
				it("keeps text at 4.5:1 on every surface", () => check(theme, text, surfaces, 4.5));
				it("keeps graphics and the focus ring at 3:1", () => check(theme, ["--lm-graphic", "--lm-focus-ring"], surfaces.slice(0, 5), 3));
				it("keeps colored text readable on its own tinted surface", () => {
					check(theme, ["--lm-text-accent"], ["--lm-surface-accent", "--lm-surface-accent-strong"], 4.5);
					check(theme, ["--lm-text-danger"], ["--lm-surface-danger", "--lm-surface-danger-strong"], 4.5);
					check(theme, ["--lm-text-warning"], ["--lm-surface-warning"], 4.5);
					check(theme, ["--lm-text-success"], ["--lm-surface-success"], 4.5);
				});
				it("keeps label text readable on solid accent and danger fills", () => {
					check(theme, ["--lm-text-on-fill"], ["--lm-accent-solid", "--lm-accent-solid-hover", "--lm-danger"], 4.5);
				});
				it("keeps white text readable on each asset-kind color", () => {
					check(theme, ["--lm-text-on-asset"], ["image", "video", "audio", "text", "other"].map((n) => `--lm-asset-${n}`), 4.5);
				});
				it("keeps asset-kind colors visible against the page", () => {
					check(theme, ["image", "video", "audio", "text", "other"].map((n) => `--lm-asset-${n}`), ["--lm-surface-app", "--lm-surface-raised"], 3);
				});
			});
		}

		it("keeps the colors the main process paints in step with the tokens", () => {
			const pairs: Array<[string, string, string]> = [
				["light", "--lm-surface-subtle", "background"], ["light", "--lm-surface-window", "titleBar"], ["light", "--lm-text-primary", "titleBarSymbol"],
				["dark", "--lm-surface-subtle", "background"], ["dark", "--lm-surface-window", "titleBar"], ["dark", "--lm-text-primary", "titleBarSymbol"],
			];
			for (const [theme, token, key] of pairs) {
				const expected = lookup(token, theme as "light" | "dark").toLowerCase();
				assert.equal(WINDOW_COLORS[theme as "light" | "dark"][key as "background"].toLowerCase(), expected, `${theme} ${key} must equal ${token}`);
			}
		});
	});
});
