import type { HtmlPreviewSize } from "../../../shared/html-preview.ts";
import { createHtmlPreviewGuest } from "./html-preview-guest.ts";

const selector = ".markdown-embed-html[data-html-preview-src]";
const desktopViewport = { width: 1280, height: 720 };
const maximumViewport = { width: 4096, height: 8192 };
const recentSizes = new Map<string, HtmlPreviewSize>();

function mountHtmlEmbed(host: HTMLElement, src: string, signal: AbortSignal): void {
	const guest = createHtmlPreviewGuest(host.ownerDocument, src, host.dataset.htmlPreviewTitle ?? "", true);
	let viewport = desktopViewport;
	const scaleGuest = (width: number, height: number) => {
		const scale = Math.min(width / viewport.width, height / viewport.height);
		guest.style.scale = String(scale);
		guest.style.left = `${(width - viewport.width * scale) / 2}px`;
	};
	const resize = new ResizeObserver(([entry]) => scaleGuest(entry.contentRect.width, entry.contentRect.height));
	function updateViewport() {
		guest.style.inlineSize = `${viewport.width}px`;
		guest.style.blockSize = `${viewport.height}px`;
		scaleGuest(host.clientWidth, host.clientHeight);
	}
	function onSize(event: Electron.IpcMessageEvent) {
		if (event.channel !== "html-preview-size") return;
		const size: (HtmlPreviewSize & { unstable: boolean }) | undefined = event.args[0];
		if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
		const { width, height, unstable } = size;
		if (unstable || width > maximumViewport.width || height > maximumViewport.height) {
			// Fall back to the guest's scrollable viewport when its layout cannot converge or fit.
			guest.removeEventListener("ipc-message", onSize);
			resize.disconnect();
			recentSizes.delete(src);
			host.style.removeProperty("aspect-ratio");
			guest.style.cssText = "";
			return;
		}
		viewport = { width: Math.max(desktopViewport.width, width), height: Math.max(desktopViewport.height, height) };
		host.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
		updateViewport();
		recentSizes.delete(src);
		recentSizes.set(src, viewport);
		if (recentSizes.size > 64) recentSizes.delete(recentSizes.keys().next().value!);
	}
	guest.addEventListener("ipc-message", onSize);
	updateViewport();
	host.append(guest);
	resize.observe(host);
	signal.addEventListener("abort", () => {
		guest.removeEventListener("ipc-message", onSize);
		resize.disconnect();
	}, { once: true });
}

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
			if (!host.firstElementChild) mountHtmlEmbed(host, host.dataset.htmlPreviewSrc!, signal);
		}
	});
	for (const host of hosts) {
		const size = recentSizes.get(host.dataset.htmlPreviewSrc!);
		if (size) host.style.aspectRatio = `${size.width} / ${size.height}`;
		observer.observe(host);
	}
	signal.addEventListener("abort", () => {
		observer.disconnect();
		hosts.forEach((host) => host.replaceChildren());
	}, { once: true });
}
