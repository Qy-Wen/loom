import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./loom.ts";

test.beforeEach(async ({ electronApp }) => {
	test.setTimeout(60_000);
	test.skip(!electronApp, "isolated library required");
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "Rename" && item.enabled)?.click();
			options?.callback?.();
		};
	});
});

async function prepareFolders(page: Page): Promise<void> {
	await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await mkdir(join(root, "parent", "child"), { recursive: true });
	await mkdir(join(root, "sibling"));
	await writeFile(join(root, "parent", "child", "note.md"), "# Folder contents");
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(3);
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(1);
	await page.locator(".library-display-tabs").getByRole("button", { name: "Icons", exact: true }).click();
}

test("icon-mode tree folders rename in place without moving the browser", async ({ loomPage: page }) => {
	await prepareFolders(page);
	const sidebar = page.locator(".library-sidebar");
	const browser = page.locator(".folder-browser");
	const folder = (name: string) => sidebar.locator(".folder-main").filter({ hasText: new RegExp(`^${name}$`) });
	const tile = (name: string) => browser.locator(".browser-tile").filter({ has: page.locator(".browser-tile-name", { hasText: new RegExp(`^${name}$`) }) });
	const editor = sidebar.locator(".rename-editor input");
	const folders = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).folders);
	const crumbs = await browser.locator(".browser-crumb").allTextContents();

	// The same folder is visible in both views, but only the tree gets an editor.
	await folder("parent").click({ button: "right" });
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("parent");
	await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
	await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
	await editor.fill("cancelled");
	await editor.press("Escape");
	await expect(editor).toHaveCount(0);
	await expect.poll(folders).toContain("parent");
	await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);

	await folder("parent").click({ button: "right" });
	await editor.fill("renamed");
	await editor.press("Enter");
	await expect.poll(folders).toContain("renamed/child");
	await expect(editor).toHaveCount(0);
	await expect(tile("renamed")).toBeVisible();
	await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);

	// Renaming an ancestor keeps the browser inside its child, including its files.
	await tile("renamed").dblclick();
	await tile("child").dblclick();
	await expect(tile("note.md")).toBeVisible();
	await folder("renamed").click({ button: "right" });
	await expect(editor).toBeFocused();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
	await editor.fill("parent-final");
	await editor.press("Enter");
	await expect.poll(folders).toContain("parent-final/child");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
	await expect(browser.locator(".browser-crumb").filter({ hasText: /^parent-final$/ })).toHaveCount(1);
	await expect(tile("note.md")).toBeVisible();

	// F2 follows the focused tree even when browsing selected no tile.
	await folder("child").click();
	await folder("child").press("F2");
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("child");
	await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
	await editor.fill("child-final");
	await editor.press("Enter");
	await expect.poll(folders).toContain("parent-final/child-final");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child-final");
	await expect(tile("note.md")).toBeVisible();

	// Renaming an unrelated tree row on blur does not leave the current folder.
	await folder("sibling").click({ button: "right" });
	await expect(editor).toBeFocused();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child-final");
	await editor.fill("sibling-final");
	await browser.locator(".browser-crumb.current").click();
	await expect.poll(folders).toContain("sibling-final");
	await expect(editor).toHaveCount(0);
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child-final");
});

test("folder tiles keep their own rename editor and list mode still renames in the tree", async ({ loomPage: page }) => {
	await prepareFolders(page);
	const sidebar = page.locator(".library-sidebar");
	const browser = page.locator(".folder-browser");
	const tile = (name: string) => browser.locator(".browser-tile.folder").filter({ has: page.locator(".browser-tile-name", { hasText: new RegExp(`^${name}$`) }) });
	const editor = browser.locator(".browser-tile-rename input");
	const folders = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).folders);

	await tile("parent").click({ button: "right" });
	await expect(editor).toBeFocused();
	await expect(sidebar.locator(".rename-editor")).toHaveCount(0);
	await editor.fill("tile-renamed");
	await editor.press("Enter");
	await expect.poll(folders).toContain("tile-renamed/child");
	await expect(tile("tile-renamed")).toBeVisible();

	await tile("tile-renamed").press("F2");
	await expect(editor).toBeFocused();
	await expect(sidebar.locator(".rename-editor")).toHaveCount(0);
	await editor.fill("cancelled");
	await editor.press("Escape");
	await expect(editor).toHaveCount(0);
	await expect.poll(folders).toContain("tile-renamed");

	await tile("tile-renamed").press("F2");
	await editor.fill("tile-final");
	await editor.press("Enter");
	await expect.poll(folders).toContain("tile-final/child");
	await expect(editor).toHaveCount(0);
	await expect(tile("tile-final")).toBeVisible();

	await browser.locator(".browser-scroll").press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+N`);
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("New Folder");
	await expect(sidebar.locator(".rename-editor")).toHaveCount(0);
	await editor.fill("created");
	await editor.press("Enter");
	await expect.poll(folders).toContain("created");

	await page.locator(".library-display-tabs").getByRole("button", { name: "List", exact: true }).click();
	await sidebar.locator(".folder-main").filter({ hasText: /^tile-final$/ }).click({ button: "right" });
	const treeEditor = sidebar.locator(".rename-editor input");
	await expect(treeEditor).toBeFocused();
	await treeEditor.fill("list-final");
	await treeEditor.press("Enter");
	await expect.poll(folders).toContain("list-final/child");
	await expect(treeEditor).toHaveCount(0);
	await expect(sidebar.locator(".folder-row.selected")).toHaveText("list-final");
});
