/**
 * Headings and anchors compare by this key: case, punctuation and the choice between spaces and hyphens
 * do not matter, so `[[笔记#Q&A 总结]]` and `笔记.md#q-a-总结` both find "Q&A 总结".
 */
export function headingKey(text: string): string {
	return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The heading a written target's `#fragment` points to. Block IDs (`#^id`) are not supported and give no anchor. */
export function anchorOf(fragment: string): string | undefined {
	let text = fragment;
	try {
		text = decodeURIComponent(fragment);
	} catch {
		// Keep the text as written.
	}
	const last = text.split("#").pop() ?? "";
	if (last.startsWith("^")) return undefined;
	return headingKey(last) || undefined;
}
