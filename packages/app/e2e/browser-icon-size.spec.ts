import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("icon size slider and minus/plus resize both tile types and persist across navigation and display modes", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await mkdir(join(root, "folder"));
	await Promise.all(Array.from({ length: 12 }, (_, index) => writeFile(join(root, `item-${String(index).padStart(2, "0")}.md`), "# item")));
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(12);
	const display = loomPage.locator(".library-display-tabs");
	await display.getByRole("button", { name: "Icons", exact: true }).click();
	const browser = loomPage.locator(".folder-browser");
	const control = browser.getByRole("group", { name: "Icon size", exact: true });
	const slider = control.getByRole("slider", { name: "Icon size", exact: true });
	const smaller = control.getByRole("button", { name: "Smaller icons", exact: true });
	const larger = control.getByRole("button", { name: "Larger icons", exact: true });
	const thumbnail = browser.locator(".browser-tile:not(.folder) .browser-tile-thumb").first();
	const folderIcon = browser.locator(".browser-tile.folder .browser-folder-art");
	await expect(slider).toHaveValue("112");
	await expect(slider).toHaveAttribute("min", "80");
	await expect(slider).toHaveAttribute("max", "240");
	await expect(slider).toHaveAttribute("step", "16");
	const minusBounds = (await smaller.boundingBox())!;
	const sliderBounds = (await slider.boundingBox())!;
	const plusBounds = (await larger.boundingBox())!;
	expect(minusBounds.x + minusBounds.width).toBeLessThanOrEqual(sliderBounds.x);
	expect(sliderBounds.x + sliderBounds.width).toBeLessThanOrEqual(plusBounds.x);
	expect((await thumbnail.boundingBox())!.width).toBeCloseTo(100, 0);
	const initialFolderSize = (await folderIcon.boundingBox())!.width;
	await larger.click();
	await expect(slider).toHaveValue("128");
	expect((await thumbnail.boundingBox())!.width).toBeCloseTo(116, 0);
	expect((await folderIcon.boundingBox())!.width).toBeGreaterThan(initialFolderSize);
	await smaller.click();
	await expect(slider).toHaveValue("112");
	// Dragging the slider continuously updates the same preference.
	await loomPage.mouse.move(sliderBounds.x + sliderBounds.width / 2, sliderBounds.y + sliderBounds.height / 2);
	await loomPage.mouse.down();
	await loomPage.mouse.move(sliderBounds.x + sliderBounds.width - 4, sliderBounds.y + sliderBounds.height / 2, { steps: 6 });
	await loomPage.mouse.up();
	await expect(slider).toHaveValue("240");
	await expect(larger).toBeDisabled();
	await slider.focus();
	await slider.press("Home");
	await expect(slider).toHaveValue("80");
	await expect(smaller).toBeDisabled();
	expect((await thumbnail.boundingBox())!.width).toBeCloseTo(68, 0);
	await slider.press("End");
	await slider.press("ArrowLeft");
	await expect(slider).toHaveValue("224");
	await expect(slider).toHaveAttribute("aria-valuetext", "224px");
	// Grid movement uses the resized columns, while slider keys do not change tile selection.
	const tiles = browser.locator(".browser-tile");
	await tiles.nth(1).click();
	await slider.focus();
	await slider.press("ArrowLeft");
	await expect(tiles.nth(1)).toHaveClass(/selected/);
	const columns = await tiles.evaluateAll((elements) => elements.filter((element) => (element as HTMLElement).offsetTop === (elements[0] as HTMLElement).offsetTop).length);
	await browser.locator(".browser-scroll").focus();
	await loomPage.keyboard.press("ArrowDown");
	await expect(tiles.nth(1 + columns)).toHaveClass(/selected/);
	await tiles.filter({ has: loomPage.locator(".browser-tile-name", { hasText: /^folder$/ }) }).dblclick();
	await expect(slider).toHaveValue("208");
	await loomPage.locator(".library-root-button").click();
	await expect(thumbnail).toBeVisible();
	await display.getByRole("button", { name: "List", exact: true }).click();
	await expect(browser).toHaveCount(0);
	await display.getByRole("button", { name: "Icons", exact: true }).click();
	await expect(slider).toHaveValue("208");
	await loomPage.reload();
	await expect(slider).toHaveValue("208");
});

test("large icons fit a narrow browser and invalid saved sizes fall back safely", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await writeFile(join(root, "item.md"), "# item");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(1);
	await loomPage.evaluate(() => {
		localStorage.setItem("loom.library.fileDisplay", "icons");
		localStorage.setItem("loom.browser.iconSize", "invalid");
	});
	await loomPage.reload();
	const browser = loomPage.locator(".folder-browser");
	const slider = browser.getByRole("slider", { name: "Icon size", exact: true });
	await expect(slider).toHaveValue("112");
	const initialBar = (await browser.locator(".browser-bar").boundingBox())!;
	const initialSliderWidth = (await slider.boundingBox())!.width;
	const initialSearchWidth = (await browser.locator(".browser-search").boundingBox())!.width;
	await browser.evaluate((element) => { element.style.maxWidth = "260px"; });
	const narrowBar = (await browser.locator(".browser-bar").boundingBox())!;
	expect(narrowBar.height).toBe(initialBar.height);
	expect(await slider.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(initialSliderWidth);
	expect((await browser.locator(".browser-search").boundingBox())!.width).toBeLessThan(initialSearchWidth);
	const larger = browser.getByRole("button", { name: "Larger icons", exact: true });
	for (let index = 0; index < 8; index += 1) await larger.click();
	await expect(slider).toHaveValue("240");
	expect(await browser.locator(".browser-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	const thumbnail = (await browser.locator(".browser-tile-thumb").boundingBox())!;
	expect(thumbnail.width).toBeCloseTo(thumbnail.height, 0);
	const bar = (await browser.locator(".browser-bar").boundingBox())!;
	for (const selector of [".browser-icon-size", ".browser-search", ".file-sort"]) {
		const bounds = (await browser.locator(selector).boundingBox())!;
		expect(bounds.x).toBeGreaterThanOrEqual(bar.x);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(bar.x + bar.width);
		expect(bounds.y + bounds.height / 2).toBeCloseTo(bar.y + (bar.height - 2) / 2, 0); // Centered above the border and its 1px balancing padding.
	}
	// Horizontal cropping must not swallow the sort dropdown below the bar.
	await browser.getByRole("button", { name: "Sort files", exact: true }).click();
	await browser.getByRole("menuitemradio", { name: "Name", exact: true }).click();
	await expect(browser.getByRole("menu")).toHaveCount(0);
	await browser.evaluate((element) => { element.style.maxWidth = "160px"; });
	await expect(browser.locator(".browser-bar")).toHaveCSS("flex-wrap", "nowrap");
	await expect(browser.locator(".browser-bar")).toHaveCSS("overflow-x", "clip");
	expect((await browser.locator(".browser-bar").boundingBox())!.height).toBe(initialBar.height);
});
