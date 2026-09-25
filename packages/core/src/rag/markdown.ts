import { extname } from "node:path";

export function canEmbedMarkdown(filename: string): boolean {
	return extname(filename).toLowerCase() === ".md";
}
