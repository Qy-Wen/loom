import { session, webContents, type Session, type WebContents, type WebPreferences } from "electron";
import { HTML_PREVIEW_FIT_PARAM, HTML_PREVIEW_PARTITION, HTML_PREVIEW_SCHEME } from "../../shared/html-preview.ts";
import sizePreload from "../../preload/html-preview-size.cjs?asset";

const policy = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

function previewAssetId(raw: string): string | undefined {
	const url = URL.parse(raw);
	if (!url || url.protocol !== `${HTML_PREVIEW_SCHEME}:` || url.host !== "asset" || url.username || url.password) return;
	return /^\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(url.pathname)?.[1];
}

let previewSession: Session | undefined;

function getPreviewSession(readHtml: (assetId: string) => Promise<string>): Session {
	if (previewSession) return previewSession;
	// The preview has its own protocols and permission state.
	const isolated = session.fromPartition(HTML_PREVIEW_PARTITION, { cache: false });
	isolated.setPermissionCheckHandler(() => false);
	isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	isolated.setDevicePermissionHandler(() => false);
	isolated.on("will-download", (event) => event.preventDefault());
	isolated.enableNetworkEmulation({ offline: true });
	isolated.webRequest.onBeforeRequest(({ url, resourceType, webContentsId }, callback) => {
		const guest = webContentsId === undefined ? undefined : webContents.fromId(webContentsId);
		const previewDocument = resourceType === "mainFrame" && guest?.getType() === "webview" && previewAssetId(url);
		callback({ cancel: !previewDocument && !url.startsWith("data:") });
	});
	isolated.protocol.handle(HTML_PREVIEW_SCHEME, async ({ url }) => {
		const assetId = previewAssetId(url);
		if (!assetId) return new Response(null, { status: 404 });
		const headers = new Headers({
			"Content-Security-Policy": policy,
			"Cache-Control": "no-store",
			"X-DNS-Prefetch-Control": "off",
		});
		try {
			const html = await readHtml(assetId);
			headers.set("Content-Type", "text/html; charset=utf-8");
			return new Response(html, { headers });
		} catch (error) {
			headers.set("Content-Type", "text/plain; charset=utf-8");
			return new Response(error instanceof Error ? error.message : "Failed to load HTML preview", { status: 422, headers });
		}
	});
	previewSession = isolated;
	return isolated;
}

export function allowHtmlPreview(readHtml: (assetId: string) => Promise<string>) {
	return (preferences: WebPreferences, params: Record<string, string>): boolean => {
		if (params.partition !== HTML_PREVIEW_PARTITION || !previewAssetId(params.src)) return false;
		// The embedder supplies the document URL. The main process supplies every preference.
		for (const key of Object.keys(preferences) as (keyof WebPreferences)[]) delete preferences[key];
		Object.assign(preferences, {
			session: getPreviewSession(readHtml),
			partition: HTML_PREVIEW_PARTITION,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
		} satisfies WebPreferences);
		if (new URL(params.src).searchParams.has(HTML_PREVIEW_FIT_PARAM)) preferences.preload = sizePreload;
		delete params.httpreferrer;
		delete params.useragent;
		return true;
	};
}

export function guardHtmlPreview(contents: WebContents): void {
	contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-frame-navigate", (event) => event.preventDefault());
	contents.on("will-redirect", (event) => event.preventDefault());
}
