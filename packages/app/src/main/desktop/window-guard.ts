import type { BrowserWindow } from "electron";

/** Schemes handed to the system browser or mail client. Anything else (file:, javascript:, data:, custom) is dropped. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The page the window itself is allowed to be on. A dev server URL, or the built `file:` renderer. */
export interface TrustedPage {
	/** Dev server origin, when running with one. */
	devOrigin?: string;
	/** `file:` URL of the built renderer's directory, used when there is no dev server. */
	rendererDir?: string;
}

function parse(url: string): URL | undefined {
	try { return new URL(url); } catch { return undefined; }
}

/** True for a link that should open in the system browser instead of inside Loom. */
export function isExternalUrl(url: string): boolean {
	const parsed = parse(url);
	return parsed !== undefined && EXTERNAL_SCHEMES.has(parsed.protocol);
}

/**
 * True when the window may navigate to `url` itself: the app's own page, or an in-page anchor change.
 * Reloading and hash routing stay allowed; leaving the app does not.
 */
export function isTrustedNavigation(url: string, trusted: TrustedPage): boolean {
	const parsed = parse(url);
	if (!parsed) return false;
	if (trusted.devOrigin) {
		const dev = parse(trusted.devOrigin);
		return dev !== undefined && parsed.origin === dev.origin;
	}
	if (parsed.protocol !== "file:" || !trusted.rendererDir) return false;
	const dir = parse(trusted.rendererDir);
	return dir !== undefined && decodeURIComponent(parsed.pathname).startsWith(decodeURIComponent(dir.pathname));
}

export interface WindowGuardOptions {
	trusted: TrustedPage;
	/** Open a URL in the system browser. Injected so tests do not launch one. */
	openExternal: (url: string) => void | Promise<void>;
	/** Called when a navigation or new window was refused, for the app log. */
	onBlocked?: (reason: string, url: string) => void;
}

/**
 * Keep a window on the app's own page. The renderer shows text written by models, web pages, and files, and the
 * window exposes the `loom` bridge, so a link that replaced the page would hand that bridge to a foreign site.
 *
 * - A new window request (`target="_blank"`, `window.open`) is never created. A web or mail link goes to the
 *   system browser; anything else is refused.
 * - A navigation away from the app's page is cancelled; a web link is opened in the system browser instead.
 * - A webview cannot be attached.
 */
export function guardWindow(win: BrowserWindow, options: WindowGuardOptions): void {
	const { trusted, openExternal, onBlocked } = options;
	const handOff = (url: string): void => {
		if (!isExternalUrl(url)) { onBlocked?.("blocked scheme", url); return; }
		Promise.resolve(openExternal(url)).catch((error) => onBlocked?.(`could not open: ${error instanceof Error ? error.message : String(error)}`, url));
	};
	win.webContents.setWindowOpenHandler(({ url }) => {
		handOff(url);
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (isTrustedNavigation(url, trusted)) return;
		event.preventDefault();
		handOff(url);
	});
	win.webContents.on("will-redirect", (event, url) => {
		if (isTrustedNavigation(url, trusted)) return;
		event.preventDefault();
		onBlocked?.("blocked redirect", url);
	});
	win.webContents.on("will-attach-webview", (event) => {
		event.preventDefault();
		onBlocked?.("blocked webview", "");
	});
}

/** How many times a crashed renderer is reloaded inside the window below before the window is left as it is. */
export const RENDERER_RELOAD_LIMIT = 3;
export const RENDERER_RELOAD_WINDOW_MS = 60_000;

/**
 * Log a renderer that crashed or was killed, and reload it so the user is not left with a blank window.
 * The page loads its state from Main again, so a reload loses only what was unsaved in the page. A renderer that
 * keeps crashing is not reloaded forever: after {@link RENDERER_RELOAD_LIMIT} reloads in a minute it stays down
 * and the log says so.
 */
export function watchRenderer(win: BrowserWindow, log: (message: string) => void, now: () => number = Date.now): void {
	const reloads: number[] = [];
	win.webContents.on("render-process-gone", (_event, details) => {
		log(`renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
		// A clean exit or a deliberate kill is not a crash to recover from.
		if (details.reason === "clean-exit" || details.reason === "killed" || win.isDestroyed()) return;
		const recent = reloads.filter((at) => now() - at < RENDERER_RELOAD_WINDOW_MS);
		if (recent.length >= RENDERER_RELOAD_LIMIT) {
			log(`renderer crashed ${recent.length + 1} times within ${RENDERER_RELOAD_WINDOW_MS / 1000}s; not reloading again`);
			return;
		}
		reloads.length = 0;
		reloads.push(...recent, now());
		win.webContents.reload();
	});
	win.webContents.on("unresponsive", () => log("window is unresponsive"));
	win.webContents.on("responsive", () => log("window is responsive again"));
}
