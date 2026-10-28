import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { BrowserWindow } from "electron";
import {
	RENDERER_RELOAD_LIMIT,
	RENDERER_RELOAD_WINDOW_MS,
	guardWindow,
	isExternalUrl,
	isTrustedNavigation,
	watchRenderer,
} from "../src/main/desktop/window-guard.ts";

const FILE_APP = { rendererDir: "file:///Applications/Loom.app/Contents/Resources/app.asar/out/renderer/" };
const DEV_APP = { devOrigin: "http://localhost:5173" };

describe("isExternalUrl", () => {
	it("accepts web and mail links only", () => {
		for (const url of ["https://example.com/a", "http://example.com", "mailto:a@b.co"]) assert.equal(isExternalUrl(url), true, url);
		for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "loom-asset://asset/1", "vscode://x", "ftp://x", "", "not a url", "//example.com"]) {
			assert.equal(isExternalUrl(url), false, url);
		}
	});
});

describe("isTrustedNavigation", () => {
	it("allows the built renderer page, with a hash or query", () => {
		assert.equal(isTrustedNavigation(`${FILE_APP.rendererDir}index.html`, FILE_APP), true);
		assert.equal(isTrustedNavigation(`${FILE_APP.rendererDir}index.html#/library`, FILE_APP), true);
		assert.equal(isTrustedNavigation(`${FILE_APP.rendererDir}index.html?x=1`, FILE_APP), true);
	});

	it("refuses other files, other sites, and a path that only looks similar", () => {
		assert.equal(isTrustedNavigation("file:///etc/passwd", FILE_APP), false);
		assert.equal(isTrustedNavigation("https://example.com/", FILE_APP), false);
		assert.equal(isTrustedNavigation("file:///Applications/Loom.app/Contents/Resources/app.asar/out/renderer-evil/index.html", FILE_APP), false);
		assert.equal(isTrustedNavigation("file:///Applications/Loom.app/Contents/Resources/app.asar/out/renderer/../main/index.js", FILE_APP), false);
	});

	it("with a dev server, trusts that origin only", () => {
		assert.equal(isTrustedNavigation("http://localhost:5173/", DEV_APP), true);
		assert.equal(isTrustedNavigation("http://localhost:5173/#/x", DEV_APP), true);
		assert.equal(isTrustedNavigation("http://localhost:5174/", DEV_APP), false);
		assert.equal(isTrustedNavigation("https://localhost:5173/", DEV_APP), false);
		assert.equal(isTrustedNavigation("http://localhost:5173.evil.com/", DEV_APP), false);
		assert.equal(isTrustedNavigation(`${FILE_APP.rendererDir}index.html`, DEV_APP), false);
	});

	it("refuses an unparsable URL and any URL when nothing is trusted", () => {
		assert.equal(isTrustedNavigation("::::", FILE_APP), false);
		assert.equal(isTrustedNavigation("file:///x", {}), false);
	});
});

type Handler = (details: { url: string }) => { action: "deny" | "allow" };

function fakeWindow() {
	const webContents = Object.assign(new EventEmitter(), {
		openHandler: undefined as Handler | undefined,
		reloads: 0,
		setWindowOpenHandler(handler: Handler) { this.openHandler = handler; },
		reload() { this.reloads += 1; },
	});
	let destroyed = false;
	const win = { webContents, isDestroyed: () => destroyed } as unknown as BrowserWindow;
	return { win, webContents, destroy: () => { destroyed = true; } };
}

function navigate(webContents: EventEmitter, event: "will-navigate" | "will-redirect", url: string): boolean {
	let prevented = false;
	webContents.emit(event, { preventDefault: () => { prevented = true; } }, url);
	return prevented;
}

describe("guardWindow", () => {
	function guarded(trusted = FILE_APP) {
		const opened: string[] = [];
		const blocked: string[] = [];
		const fake = fakeWindow();
		guardWindow(fake.win, {
			trusted,
			openExternal: (url) => { opened.push(url); },
			onBlocked: (reason, url) => blocked.push(`${reason}: ${url}`),
		});
		return { ...fake, opened, blocked };
	}

	it("never creates a window, and sends a web link to the system browser", () => {
		const { webContents, opened } = guarded();
		assert.deepEqual(webContents.openHandler!({ url: "https://example.com/a" }), { action: "deny" });
		assert.deepEqual(opened, ["https://example.com/a"]);
	});

	it("refuses a window for a non-web scheme without opening anything", () => {
		const { webContents, opened, blocked } = guarded();
		for (const url of ["file:///etc/passwd", "javascript:alert(1)", "loom-asset://asset/x"]) {
			assert.deepEqual(webContents.openHandler!({ url }), { action: "deny" });
		}
		assert.deepEqual(opened, []);
		assert.equal(blocked.length, 3);
	});

	it("cancels a navigation away from the app and opens web links externally", () => {
		const { webContents, opened } = guarded();
		assert.equal(navigate(webContents, "will-navigate", "https://example.com/"), true);
		assert.deepEqual(opened, ["https://example.com/"]);
	});

	it("cancels an unsafe navigation without opening it", () => {
		const { webContents, opened, blocked } = guarded();
		assert.equal(navigate(webContents, "will-navigate", "file:///etc/passwd"), true);
		assert.deepEqual(opened, []);
		assert.equal(blocked.length, 1);
	});

	it("leaves the app's own page and in-page anchors alone", () => {
		const { webContents, opened } = guarded();
		assert.equal(navigate(webContents, "will-navigate", `${FILE_APP.rendererDir}index.html#section`), false);
		assert.equal(navigate(webContents, "will-redirect", `${FILE_APP.rendererDir}index.html`), false);
		assert.deepEqual(opened, []);
	});

	it("cancels a redirect off the app and does not follow it", () => {
		const { webContents, opened, blocked } = guarded();
		assert.equal(navigate(webContents, "will-redirect", "https://example.com/"), true);
		assert.deepEqual(opened, [], "a redirect is not a click, so nothing is opened");
		assert.equal(blocked.length, 1);
	});

	it("blocks a webview", () => {
		const { webContents, blocked } = guarded();
		let prevented = false;
		webContents.emit("will-attach-webview", { preventDefault: () => { prevented = true; } });
		assert.equal(prevented, true);
		assert.equal(blocked.length, 1);
	});

	it("reports a failure to open the browser instead of throwing", async () => {
		const blocked: string[] = [];
		const fake = fakeWindow();
		guardWindow(fake.win, {
			trusted: FILE_APP,
			openExternal: () => Promise.reject(new Error("no handler")),
			onBlocked: (reason) => blocked.push(reason),
		});
		fake.webContents.openHandler!({ url: "https://example.com/" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(blocked[0] ?? "", /could not open: no handler/);
	});
});

describe("watchRenderer", () => {
	function crash(webContents: EventEmitter, reason = "crashed"): void {
		webContents.emit("render-process-gone", {}, { reason, exitCode: 1 });
	}

	it("logs a crash and reloads the page", () => {
		const fake = fakeWindow();
		const log: string[] = [];
		watchRenderer(fake.win, (line) => log.push(line));
		crash(fake.webContents);
		assert.equal(fake.webContents.reloads, 1);
		assert.match(log[0]!, /reason=crashed/);
	});

	it("does not reload after a clean exit, a deliberate kill, or a closed window", () => {
		const fake = fakeWindow();
		watchRenderer(fake.win, () => {});
		crash(fake.webContents, "clean-exit");
		crash(fake.webContents, "killed");
		assert.equal(fake.webContents.reloads, 0);
		fake.destroy();
		crash(fake.webContents);
		assert.equal(fake.webContents.reloads, 0);
	});

	it("stops reloading a renderer that keeps crashing, and says so", () => {
		const fake = fakeWindow();
		const log: string[] = [];
		let time = 1_000;
		watchRenderer(fake.win, (line) => log.push(line), () => time);
		for (let i = 0; i < RENDERER_RELOAD_LIMIT + 2; i++) { crash(fake.webContents); time += 1_000; }
		assert.equal(fake.webContents.reloads, RENDERER_RELOAD_LIMIT);
		assert.ok(log.some((line) => /not reloading again/.test(line)));
	});

	it("reloads again once the crashes are far enough apart", () => {
		const fake = fakeWindow();
		let time = 0;
		watchRenderer(fake.win, () => {}, () => time);
		for (let i = 0; i < RENDERER_RELOAD_LIMIT; i++) { crash(fake.webContents); time += 1_000; }
		time += RENDERER_RELOAD_WINDOW_MS;
		crash(fake.webContents);
		assert.equal(fake.webContents.reloads, RENDERER_RELOAD_LIMIT + 1);
	});

	it("logs an unresponsive window", () => {
		const fake = fakeWindow();
		const log: string[] = [];
		watchRenderer(fake.win, (line) => log.push(line));
		fake.webContents.emit("unresponsive");
		assert.match(log[0]!, /unresponsive/);
	});
});
