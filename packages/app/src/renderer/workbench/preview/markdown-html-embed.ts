import { createHtmlPreviewGuest } from "./html-preview-guest.ts";

const selector = ".markdown-embed-html[data-html-preview-src]";

/** Start each guest on its first visible frame and keep it alive while the embed is mounted. */
export function observeHtmlEmbeds(root: HTMLElement, signal: AbortSignal): void {
	const hosts = root.querySelectorAll<HTMLElement>(selector);
	if (!hosts.length || signal.aborted) return;
	const observer = new IntersectionObserver((entries) => {
		if (signal.aborted) return;
		for (const entry of entries) {
			if (!entry.isIntersecting || !entry.target.isConnected) continue;
			const host = entry.target as HTMLElement;
			observer.unobserve(host);
			host.append(createHtmlPreviewGuest(host.ownerDocument, host.dataset.htmlPreviewSrc!, host.dataset.htmlPreviewTitle ?? ""));
		}
	});
	hosts.forEach((host) => observer.observe(host));
	signal.addEventListener("abort", () => {
		observer.disconnect();
		hosts.forEach((host) => host.replaceChildren());
	}, { once: true });
}
