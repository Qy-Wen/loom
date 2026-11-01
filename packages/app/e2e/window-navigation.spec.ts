import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { launchTestElectron } from "./loom.ts";

/** Put a link in the page, as a chat reply or a Markdown preview would, and click it. */
async function clickLink(page: Page, attributes: string): Promise<void> {
	await page.evaluate((attrs) => {
		document.getElementById("probe-link")?.remove();
		const holder = document.createElement("div");
		holder.id = "probe-link";
		holder.style.cssText = "position:fixed;top:0;left:0;z-index:99999";
		holder.innerHTML = `<a id="probe-anchor" ${attrs}>probe</a>`;
		document.body.appendChild(holder);
	}, attributes);
	// Click from inside the page. Playwright's own click waits for a navigation, and a cancelled one never ends.
	await page.evaluate(() => (document.getElementById("probe-anchor") as HTMLAnchorElement).click());
}

test.describe("links cannot take the window off the app", () => {
	let root: string;
	let app: ElectronApplication;
	let page: Page;
	let start: string;

	test.beforeAll(async () => {
		test.skip(Boolean(process.env.LOOM_CDP_URL?.trim()), "isolated process required");
		root = await mkdtemp(join(tmpdir(), "loom-nav-"));
		const userData = join(root, "user-data");
		await mkdir(userData, { recursive: true });
		await writeFile(join(userData, "general.json"), JSON.stringify({ language: "en", reopenLastLibrary: false }));
		app = await launchTestElectron(userData);
		// Record what the app asks the system to open, and never open it.
		await app.evaluate(({ shell }) => {
			const opened: string[] = [];
			(globalThis as { __opened?: string[] }).__opened = opened;
			shell.openExternal = async (url: string) => { opened.push(url); };
		});
		page = await app.firstWindow();
		await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
		start = page.url();
	});

	test.afterAll(async () => {
		await app?.close().catch(() => {});
		if (root) await rm(root, { recursive: true, force: true });
	});

	const opened = () => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);
	const windows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

	test("a plain link stays on the app and opens in the system browser", async () => {
		const before = await opened();
		await clickLink(page, 'href="https://example.com/plain"');
		await expect.poll(opened).toEqual([...before, "https://example.com/plain"]);
		expect(page.url()).toBe(start);
		// Ask the page itself, not a locator: Playwright waits for a "navigation" that was cancelled and never ends.
		expect(await page.evaluate(() => document.body.innerText.includes("Loom"))).toBe(true);
	});

	test("a link that asks for a new window does not create one", async () => {
		const count = await windows();
		const before = await opened();
		await clickLink(page, 'href="https://example.org/blank" target="_blank" rel="noopener"');
		await expect.poll(opened).toEqual([...before, "https://example.org/blank"]);
		expect(await windows()).toBe(count);
		expect(page.url()).toBe(start);
	});

	test("a file: link goes nowhere", async () => {
		const before = await opened();
		await clickLink(page, 'href="file:///etc/hosts"');
		await page.waitForTimeout(500);
		expect(await opened()).toEqual(before);
		expect(page.url()).toBe(start);
	});

	test("window.open to a web page does not create a window", async () => {
		const count = await windows();
		const before = await opened();
		await page.evaluate(() => { window.open("https://example.net/popup", "_blank"); });
		await expect.poll(opened).toEqual([...before, "https://example.net/popup"]);
		expect(await windows()).toBe(count);
	});

	test("the app still works after all of that", async () => {
		expect(page.url()).toBe(start);
		await page.evaluate(() => {
			const button = [...document.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === "Settings");
			if (!button) throw new Error("Settings button not found");
			button.click();
		});
		await expect.poll(() => page.evaluate(() => document.querySelector(".settings-dialog") !== null)).toBe(true);
		await page.keyboard.press("Escape");
	});
});
