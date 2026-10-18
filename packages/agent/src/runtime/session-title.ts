import { stripInlineAssetRefs } from "../context/composer-asset.ts";

/** Product-level title helpers; durable metadata stores titles outside the transcript. */
export const DEFAULT_SESSION_TITLE = "New session";

export function titleFromUserText(text: string): string {
	const compact = stripInlineAssetRefs(text).replace(/\s+/g, " ").trim();
	return (compact.slice(0, 42) + (compact.length > 42 ? "…" : "")) || DEFAULT_SESSION_TITLE;
}
