/** Product-level session title helpers; storage itself lives in the Harness session repo. */
export const DEFAULT_SESSION_TITLE = "New session";

export function titleFromUserText(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return (compact.slice(0, 42) + (compact.length > 42 ? "…" : "")) || DEFAULT_SESSION_TITLE;
}
