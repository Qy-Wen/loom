import { HTML_PREVIEW_PARTITION, HTML_PREVIEW_SCHEME } from "../../../shared/html-preview.ts";

export function createHtmlPreviewGuest(document: Document, src: string, title: string): HTMLElement {
	const url = new URL(src);
	const guest = document.createElement("webview");
	guest.setAttribute("partition", HTML_PREVIEW_PARTITION);
	guest.setAttribute("src", `${HTML_PREVIEW_SCHEME}://${url.host}${url.pathname}${url.search}`);
	guest.setAttribute("aria-label", title);
	return guest;
}
