import { HEADING_ATTRIBUTE } from "./markdown.ts";

/** A jump to a heading in a file that is still opening. Only the latest request is kept. */
let pending: { assetId: string; anchor: string } | null = null;

export function requestHeading(assetId: string, anchor: string): void {
	pending = { assetId, anchor };
}

/** Scroll to the first heading matching `anchor`. Returns false when the document has none. */
export function scrollToHeading(root: HTMLElement, anchor: string): boolean {
	for (const heading of root.querySelectorAll<HTMLElement>(`[${HEADING_ATTRIBUTE}]`)) {
		if (heading.getAttribute(HEADING_ATTRIBUTE) !== anchor) continue;
		heading.scrollIntoView({ block: "start" });
		return true;
	}
	return false;
}

/** Run the request waiting for `assetId`, if any. It is dropped even when the heading is missing. */
export function takePendingHeading(assetId: string, root: HTMLElement): void {
	if (pending?.assetId !== assetId) return;
	const { anchor } = pending;
	pending = null;
	scrollToHeading(root, anchor);
}
