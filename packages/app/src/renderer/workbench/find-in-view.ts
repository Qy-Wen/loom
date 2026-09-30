const MATCH_HIGHLIGHT = "loom-find-match";
const CURRENT_HIGHLIGHT = "loom-find-current";

export function findMatchOffsets(text: string, query: string): number[] {
	if (!query) return [];
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase();
	const hits: number[] = [];
	let from = 0;
	while (from < haystack.length) {
		const index = haystack.indexOf(needle, from);
		if (index === -1) break;
		hits.push(index);
		from = index + Math.max(needle.length, 1);
	}
	return hits;
}

export function collectTextRanges(root: HTMLElement, query: string): Range[] {
	const trimmed = query.trim();
	if (!trimmed) return [];
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = node.parentElement;
			if (!parent || parent.closest("style, script, .katex-mathml")) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	let node = walker.nextNode();
	while (node) {
		const text = node.nodeValue ?? "";
		for (const index of findMatchOffsets(text, trimmed)) {
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + trimmed.length);
			ranges.push(range);
		}
		node = walker.nextNode();
	}
	return ranges;
}

function highlightStore(): { set(name: string, value: Highlight): void; delete(name: string): void } | undefined {
	const highlights = (CSS as typeof CSS & { highlights?: Map<string, Highlight> }).highlights;
	return highlights;
}

export function applyFindHighlights(matches: Range[], currentIndex: number): void {
	const store = highlightStore();
	if (!store || typeof Highlight === "undefined") return;
	store.delete(MATCH_HIGHLIGHT);
	store.delete(CURRENT_HIGHLIGHT);
	if (matches.length === 0) return;
	store.set(MATCH_HIGHLIGHT, new Highlight(...matches));
	const current = matches[currentIndex];
	if (current) store.set(CURRENT_HIGHLIGHT, new Highlight(current));
}

export function clearFindHighlights(): void {
	const store = highlightStore();
	store?.delete(MATCH_HIGHLIGHT);
	store?.delete(CURRENT_HIGHLIGHT);
}

export function preferVisibleRect<T extends { width: number; height: number }>(rect: T, fallback: T): T {
	return rect.width > 0 || rect.height > 0 ? rect : fallback;
}

export function overflowScrollDelta(
	target: { top: number; bottom: number; left: number; right: number },
	viewport: { top: number; bottom: number; left: number; right: number },
	pad = 24,
): { top: number; left: number } {
	let top = 0;
	let left = 0;
	if (target.top < viewport.top + pad) top = target.top - (viewport.top + pad);
	else if (target.bottom > viewport.bottom - pad) top = target.bottom - (viewport.bottom - pad);
	if (target.left < viewport.left + pad) left = target.left - (viewport.left + pad);
	else if (target.right > viewport.right - pad) left = target.right - (viewport.right - pad);
	return { top, left };
}

function scrollableAncestor(start: Element): HTMLElement | null {
	let node: HTMLElement | null = start instanceof HTMLElement ? start : start.parentElement;
	while (node) {
		const style = getComputedStyle(node);
		const overflowY = style.overflowY;
		const overflowX = style.overflowX;
		const scrollY = (overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight + 1;
		const scrollX = (overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + 1;
		if (scrollY || scrollX) return node;
		node = node.parentElement;
	}
	return null;
}

export function scrollRangeIntoView(range: Range | undefined): void {
	if (!range) return;
	const node = range.startContainer;
	const element = node instanceof Element ? node : node.parentElement;
	if (!element) return;
	const scroller = scrollableAncestor(element);
	const rect = preferVisibleRect(range.getClientRects()[0] ?? range.getBoundingClientRect(), range.getBoundingClientRect());
	if (!scroller || (rect.width === 0 && rect.height === 0)) {
		element.scrollIntoView({ block: "nearest", inline: "nearest" });
		return;
	}
	const delta = overflowScrollDelta(rect, scroller.getBoundingClientRect());
	scroller.scrollTop += delta.top;
	scroller.scrollLeft += delta.left;
}
