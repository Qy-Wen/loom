import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("list navigation keeps focus while passing through consecutive videos", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await writeFile(join(root, "01.md"), "first");
	await copyFile(new URL("../../core/tests/fixtures/media/clip.mp4", import.meta.url), join(root, "02.mp4"));
	await copyFile(new URL("../../core/tests/fixtures/media/clip.mp4", import.meta.url), join(root, "03.mp4"));
	await writeFile(join(root, "04.md"), "last");
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(4);
	const sidebar = page.locator(".library-sidebar");
	await sidebar.locator(".asset-row").filter({ hasText: "01.md" }).click();
	for (const name of ["02.mp4", "03.mp4", "04.md"]) {
		await page.keyboard.press("ArrowDown");
		await expect(sidebar.locator(".asset-row.selected .asset-name")).toHaveText(name);
		if (name.endsWith(".mp4")) await expect.poll(() => page.locator(".media-stage video").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
		await expect(sidebar).toBeFocused();
	}
	await page.keyboard.press("ArrowUp");
	await expect(sidebar.locator(".asset-row.selected .asset-name")).toHaveText("03.mp4");
	await expect(sidebar).toBeFocused();
});

test("icon-mode folder tree navigates and folds independently of the grid", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	test.setTimeout(60_000);
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await mkdir(join(root, "a", "child"), { recursive: true });
	await mkdir(join(root, "b"));
	await writeFile(join(root, "a", "inside.md"), "inside");
	await Promise.all(Array.from({ length: 16 }, (_, index) => writeFile(join(root, `${String(index).padStart(2, "0")}.md`), "note")));
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(17);
	const sidebar = page.locator(".library-sidebar");
	await sidebar.getByRole("group", { name: "File display", exact: true }).getByRole("button", { name: "Icons", exact: true }).click();
	const browser = page.locator(".folder-browser");
	const row = (name: string) => sidebar.locator(".folder-row").filter({ hasText: new RegExp(`^${name}$`) });
	await row("a").locator(".folder-main").click();
	await page.keyboard.press("ArrowLeft");
	await expect(row("child")).toHaveCount(0);
	await page.keyboard.press("ArrowDown");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("b");
	await page.keyboard.press("ArrowUp");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("a");
	await page.keyboard.press("ArrowRight");
	await expect(row("child")).toBeVisible();
	await page.keyboard.press("ArrowRight");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
	await page.keyboard.press("ArrowLeft");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("a");

	// Selecting a tile must not become the cursor for subsequent folder-tree navigation.
	await browser.locator(".browser-tile").filter({ hasText: "inside.md" }).click();
	await sidebar.focus();
	await page.keyboard.press("ArrowDown");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
	await expect(sidebar).toBeFocused();

	await sidebar.locator(".library-root-button").click();
	const tiles = browser.locator(".browser-tile");
	const keys = await tiles.evaluateAll(elements => elements.map(element => element.getAttribute("data-key")));
	const columns = await tiles.evaluateAll(elements => elements.filter(element => (element as HTMLElement).offsetTop === (elements[0] as HTMLElement).offsetTop).length);
	await tiles.first().click();
	await page.keyboard.press("ArrowRight");
	await expect(browser.locator(".browser-tile.selected")).toHaveAttribute("data-key", keys[1]!);
	await page.keyboard.press("ArrowDown");
	await expect(browser.locator(".browser-tile.selected")).toHaveAttribute("data-key", keys[1 + columns]!);
	await page.keyboard.press("ArrowUp");
	await expect(browser.locator(".browser-tile.selected")).toHaveAttribute("data-key", keys[1]!);
	await page.keyboard.press("ArrowLeft");
	await expect(browser.locator(".browser-tile.selected")).toHaveAttribute("data-key", keys[0]!);
});
