declare module "*.css" {}

declare module "markdown-it-texmath" {
	import type MarkdownIt from "markdown-it";
	import type { KatexOptions } from "katex";

	interface TexmathOptions {
		engine?: { renderToString(tex: string, options?: KatexOptions): string };
		delimiters?: string | string[];
		katexOptions?: KatexOptions;
		outerSpace?: boolean;
	}

	interface TexmathRule {
		name: string;
		rex: RegExp;
		tag: string;
		displayMode?: boolean;
		outerSpace?: boolean;
		pre?(str: string, outerSpace: boolean, position: number): boolean;
		post?(str: string, outerSpace: boolean, end: number): boolean;
	}

	function texmath(md: MarkdownIt, options?: TexmathOptions): void;
	namespace texmath {
		function mergeDelimiters(delimiters: string | string[]): { inline: TexmathRule[]; block: TexmathRule[] };
	}
	export default texmath;
}
