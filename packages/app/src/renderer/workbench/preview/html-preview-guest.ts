import { HTML_PREVIEW_FIT_PARAM, HTML_PREVIEW_PARTITION, HTML_PREVIEW_SCHEME } from "../../../shared/html-preview.ts";

export function createHtmlPreviewGuest(document: Document, src: string, title: string, fitDocument = false): Electron.WebviewTag {
	const url = new URL(src);
	if (fitDocument) url.searchParams.set(HTML_PREVIEW_FIT_PARAM, "1");
	const guest = document.createElement("webview") as Electron.WebviewTag;
	guest.setAttribute("partition", HTML_PREVIEW_PARTITION);
	guest.setAttribute("src", `${HTML_PREVIEW_SCHEME}://${url.host}${url.pathname}${url.search}`);
	guest.setAttribute("aria-label", title);
	return guest;
}
