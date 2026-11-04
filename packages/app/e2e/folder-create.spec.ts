import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

for (const display of ["Icons", "List"] as const) {
	test(`${display.toLowerCase()} mode creates folders at the library root from the sidebar blank area`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await mkdir(join(root, "parent", "child"), { recursive: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
		await electronApp!.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === "New Folder" && item.enabled)?.click();
				options?.callback?.();
			};
		});

		const sidebar = page.locator(".library-sidebar");
		const browser = page.locator(".folder-browser");
		await sidebar.getByRole("button", { name: display, exact: true }).click();
		await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
		if (display === "Icons") await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		const crumbs = await browser.locator(".browser-crumb").allTextContents();

		const blank = sidebar.locator(".asset-list");
		const bounds = await blank.boundingBox();
		await blank.click({ button: "right", position: { x: bounds!.width / 2, y: bounds!.height - 10 } });
		const editor = sidebar.locator(".rename-editor input");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("New Folder");
		await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
		await editor.fill("created-at-root");
		await editor.press("Enter");
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["created-at-root", "parent", "parent/child"]);
		await expect(sidebar.locator(".folder-row.selected")).toHaveText("created-at-root");
		if (display === "Icons") {
			await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);

			// The browser's blank area still creates inside the folder being browsed.
			await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
			await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
			await browser.locator(".browser-empty").click({ button: "right" });
			const browserEditor = browser.locator(".browser-tile-rename input");
			await expect(browserEditor).toBeFocused();
			await expect(editor).toHaveCount(0);
			await browserEditor.fill("created-in-child");
			await browserEditor.press("Enter");
			await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["created-at-root", "parent", "parent/child", "parent/child/created-in-child"]);
			await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		}
	});
}

for (const source of ["folder menu", "shortcut"] as const) {
	test(`icon-mode tree ${source} creates and names folders in the tree`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await mkdir(join(root, "parent", "child"), { recursive: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
		await electronApp!.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === "New Folder" && item.enabled)?.click();
				options?.callback?.();
			};
		});
		const sidebar = page.locator(".library-sidebar");
		const browser = page.locator(".folder-browser");
		await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
		await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
		await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		const crumbs = await browser.locator(".browser-crumb").allTextContents();
		if (source === "folder menu") {
			// A collapsed ancestor must open to show the new folder without navigating away.
			await sidebar.locator(".folder-row").filter({ hasText: /^parent$/ }).getByRole("button", { name: "Collapse folder" }).click();
			await sidebar.locator(".folder-main").filter({ hasText: /^parent$/ }).click({ button: "right" });
		} else {
			await sidebar.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+N`);
		}
		const editor = sidebar.locator(".rename-editor input");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("New Folder");
		await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
		await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
		await editor.fill("created-in-tree");
		await editor.press("Enter");
		const expected = source === "folder menu" ? "parent/created-in-tree" : "parent/child/created-in-tree";
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toContain(expected);
		await expect(editor).toHaveCount(0);
		await expect(sidebar.locator(".folder-row.selected")).toHaveText("created-in-tree");
		await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
	});
}
