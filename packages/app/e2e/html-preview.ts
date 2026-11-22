import type { Locator } from "playwright";

// A new guest needs to attach and read the document before its scripts can run.
export const HTML_PREVIEW_LOAD_TIMEOUT = 12_000;

export function inPreview(preview: Locator, script: string): Promise<unknown> {
	return preview.evaluate(async (node, script) => {
		const guest = node as Electron.WebviewTag;
		try {
			if (!guest.getURL() || guest.isLoadingMainFrame()) return null;
			return await guest.executeJavaScript(script);
		} catch { return null; } // The guest may still be attaching.
	}, script);
}
