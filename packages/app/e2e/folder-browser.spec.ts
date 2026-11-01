import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

const STILL = new URL("../../core/tests/fixtures/media/still.png", import.meta.url);

test("icon mode browses one folder at a time: folder tree, path, recursive search, preview overlay, keys and box select", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	test.setTimeout(90_000);
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await mkdir(join(root, "shots", "sunset"), { recursive: true });
	await mkdir(join(root, "empty"));
	await copyFile(STILL, join(root, "cover.png"));
	await copyFile(STILL, join(root, "shots", "beach.png"));
	await copyFile(STILL, join(root, "shots", "sunset", "dusk.png"));
	await writeFile(join(root, "shots", "notes.md"), "# notes");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(4);
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(3);
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		await window.loom.setFavorite(assets.find((asset) => asset.filename === "beach.png")!.assetId, true);
	});

	const sidebar = loomPage.locator(".library-sidebar");
	const browser = loomPage.locator(".folder-browser");
	const tile = (name: string) => browser.locator(".browser-tile").filter({ has: loomPage.locator(".browser-tile-name", { hasText: new RegExp(`^${name}$`) }) });
	const strip = loomPage.getByRole("tablist", { name: "Open files" });
	const display = sidebar.getByRole("group", { name: "File display", exact: true });

	// List mode is unchanged: files in the tree open in tabs, and there is no browser.
	await sidebar.locator(".asset-row").filter({ hasText: "cover.png" }).click();
	await expect(strip.getByRole("tab", { selected: true })).toHaveText("cover.png");
	await expect(browser).toHaveCount(0);

	await display.getByRole("button", { name: "Icons", exact: true }).click();
	await expect(strip).toHaveCount(0);
	await expect(browser).toBeVisible();
	await expect(sidebar.locator(".asset-row, .asset-icon")).toHaveCount(0); // The tree shows folders only.
	await expect(sidebar.locator(".folder-row")).toHaveCount(3); // Only the 3 folders; the root is the heading.
	await expect(sidebar.locator(".folder-row.root-row")).toHaveCount(0);
	const rootHeading = sidebar.locator(".library-root-button");
	await expect(rootHeading).toHaveAttribute("aria-current", "location");
	// The heading keeps the root's import target without adding a tree row.
	expect(await rootHeading.evaluate((element) => {
		const transfer = new DataTransfer(); transfer.items.add(new File(["hello"], "drop.txt", { type: "text/plain" }));
		const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
		element.dispatchEvent(event); return event.defaultPrevented;
	})).toBe(true);
	await expect(rootHeading).toHaveClass(/drop-target/);
	await rootHeading.dispatchEvent("dragleave");
	await expect(rootHeading).not.toHaveClass(/drop-target/);
	await expect(browser.locator(".browser-crumb.current")).toHaveText(/./);
	// Root: its folders, then its files.
	await expect(browser.locator(".browser-tile")).toHaveCount(3);
	await expect(browser.locator(".browser-tile").first().locator(".browser-tile-name")).toHaveText("empty");
	await expect(tile("cover.png")).toBeVisible();
	await expect(tile("beach.png")).toHaveCount(0);

	// Square, readable tiles that fill the row.
	for (const box of await Promise.all((await browser.locator(".browser-tile-thumb").all()).map((thumb) => thumb.boundingBox()))) {
		expect(box!.width).toBeGreaterThanOrEqual(96);
		expect(box!.height).toBeCloseTo(box!.width, 0);
	}

	// Opening a folder shows its subfolder and files, and the path.
	await tile("shots").dblclick();
	await expect(browser.locator(".browser-crumb-item")).toHaveCount(2);
	await expect(browser.locator(".browser-crumb.current")).toHaveText("shots");
	await expect(browser.locator(".browser-tile")).toHaveCount(3);
	await expect(tile("sunset")).toBeVisible();
	await expect(tile("beach.png")).toBeVisible();
	await expect(tile("notes.md")).toBeVisible();
	await expect(sidebar.locator(".folder-row.selected")).toHaveText("shots");
	await expect(rootHeading).not.toHaveAttribute("aria-current");

	// Search is recursive from here and shows where each hit lives.
	const search = browser.getByRole("searchbox");
	await expect(search).toHaveAttribute("placeholder", "Search in shots");
	await search.fill("dusk");
	await expect(browser.locator(".browser-tile")).toHaveCount(1);
	await expect(tile("dusk.png").locator(".browser-tile-hint")).toHaveText("sunset");
	await search.fill("cover");
	await expect(browser.locator(".browser-empty")).toHaveText("No matching items.");
	await search.press("Escape");
	await expect(browser.locator(".browser-tile")).toHaveCount(3);

	// The path bar goes back; so does the sidebar tree, and Backspace goes up a level.
	await browser.getByRole("button", { name: "empty", exact: true }).count();
	await browser.locator("button.browser-crumb").first().click();
	await expect(browser.locator(".browser-crumb.current")).not.toHaveText("shots");
	await tile("shots").dblclick();
	await browser.locator(".browser-scroll").focus();
	await loomPage.keyboard.press("Backspace");
	await expect(browser.locator(".browser-tile")).toHaveCount(3);
	await expect(tile("cover.png")).toBeVisible();
	await sidebar.locator(".folder-row").filter({ hasText: /^sunset$/ }).locator(".folder-main").click();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("sunset");
	await expect(tile("dusk.png")).toBeVisible();
	await rootHeading.click();
	await expect(rootHeading).toHaveAttribute("aria-current", "location");
	await expect(tile("cover.png")).toBeVisible();

	// Arrow keys move the single selection through the grid; Enter opens a folder.
	await browser.locator(".browser-scroll").focus();
	await loomPage.keyboard.press("ArrowRight");
	await expect(browser.locator(".browser-tile.selected")).toHaveCount(1);
	await loomPage.keyboard.press("Home");
	await expect(browser.locator(".browser-tile").first()).toHaveClass(/selected/);
	await loomPage.keyboard.press("End");
	await expect(tile("cover.png")).toHaveClass(/selected/);
	await loomPage.keyboard.press("Shift+ArrowLeft");
	await expect(browser.locator(".browser-tile.selected")).toHaveCount(2);

	// A box drag over several tiles selects them; clicking empty space clears.
	const scroll = browser.locator(".browser-scroll");
	const first = (await browser.locator(".browser-tile").first().boundingBox())!;
	const last = (await tile("cover.png").boundingBox())!;
	const area = (await scroll.boundingBox())!;
	const startY = Math.max(area.y + 4, first.y - 6);
	await loomPage.mouse.move(last.x + last.width + 4, startY);
	await loomPage.mouse.down();
	await loomPage.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 6 });
	await expect(loomPage.locator(".browser-box")).toBeVisible();
	await loomPage.mouse.up();
	await expect(loomPage.locator(".browser-box")).toHaveCount(0);
	await expect(browser.locator(".browser-tile.selected")).toHaveCount(3);
	await loomPage.mouse.click(area.x + area.width / 2, area.y + area.height - 12);
	await expect(browser.locator(".browser-tile.selected")).toHaveCount(0);

	// Double-clicking a file opens the preview overlay on top of its folder. Escape closes it.
	await tile("cover.png").dblclick();
	const overlay = loomPage.getByRole("dialog", { name: "File preview" });
	await expect(overlay).toBeVisible();
	await expect(overlay.locator(".preview-overlay-title")).toHaveText("cover.png");
	await expect(overlay.locator("img")).toBeVisible();
	await expect(loomPage.locator('.panel-tabs button[data-tab="details"]')).toBeVisible(); // Side panels stay in reach.
	await expect(overlay.getByRole("button", { name: "Full screen" })).toHaveCount(1); // The image's own button is hidden.
	await expect(overlay.locator(".image-toolbar .preview-fullscreen")).toBeHidden();
	await electronApp!.evaluate(({ BrowserWindow }) => {
		(globalThis as { __entered?: boolean }).__entered = false;
		BrowserWindow.getAllWindows()[0]!.once("enter-full-screen", () => { (globalThis as { __entered?: boolean }).__entered = true; });
	});
	await overlay.locator(".preview-overlay-bar").getByRole("button", { name: "Full screen" }).click();
	await expect.poll(() => loomPage.evaluate(() => document.fullscreenElement?.classList.contains("preview-overlay-card") ?? false)).toBe(true);
	await expect(overlay.locator(".preview-overlay-bar").getByRole("button", { name: "Exit full screen" })).toHaveAttribute("aria-pressed", "true");
	// The page goes full screen at once but the window finishes its animation (~0.6s on macOS) later; an exit asked for
	// in between is dropped and leaves the page stuck in full screen. Wait for the window's own event.
	await expect.poll(() => electronApp!.evaluate(() => (globalThis as { __entered?: boolean }).__entered === true)).toBe(true);
	await overlay.locator(".preview-overlay-bar").getByRole("button", { name: "Exit full screen" }).click();
	await expect.poll(() => loomPage.evaluate(() => document.fullscreenElement === null), { timeout: 15_000 }).toBe(true);
	await loomPage.keyboard.press("Escape");
	await expect(overlay).toHaveCount(0);
	await expect(tile("cover.png")).toHaveClass(/selected/);

	// Favorites are a place in the sidebar; the browser lists its files and the path says so.
	await sidebar.getByRole("button", { name: "Favorites", exact: true }).click();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("Favorites");
	await expect(browser.locator(".browser-tile")).toHaveCount(1);
	await expect(tile("beach.png").locator(".asset-favorite")).toBeVisible();
	await expect(rootHeading).not.toHaveAttribute("aria-current");
	await rootHeading.focus();
	await rootHeading.press("Enter");
	await expect(rootHeading).toHaveAttribute("aria-current", "location");
	await expect(tile("cover.png")).toBeVisible();

	// The choice survives a reload.
	await loomPage.reload();
	await expect(display.getByRole("button", { name: "Icons", exact: true })).toHaveAttribute("aria-pressed", "true");
	await expect(loomPage.locator(".folder-browser")).toBeVisible();
	await display.getByRole("button", { name: "List", exact: true }).click();
	await expect(loomPage.locator(".folder-browser")).toHaveCount(0);
	await expect(sidebar.locator(".asset-row").first()).toBeVisible();
	await sidebar.locator(".asset-row").filter({ hasText: "cover.png" }).click();
	await expect(loomPage.getByRole("tablist", { name: "Open files" }).getByRole("tab", { selected: true })).toHaveText("cover.png");
});

test("icon-mode root heading replaces the root row and returns from folders, favorites, and tags", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await mkdir(join(root, "empty"));
	await writeFile(join(root, "notes.md"), "# notes");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(1);
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		await window.loom.setFavorite(assets[0]!.assetId, true);
		await window.loom.addAssetTag(assets[0]!.assetId, "Picked");
	});
	const sidebar = loomPage.locator(".library-sidebar");
	await sidebar.getByRole("group", { name: "File display", exact: true }).getByRole("button", { name: "Icons", exact: true }).click();
	const browser = loomPage.locator(".folder-browser");
	const heading = sidebar.locator(".library-root-button");
	await expect(heading).toHaveAttribute("aria-current", "location");
	await expect(sidebar.locator(".folder-row")).toHaveCount(1);
	await expect(sidebar.locator(".folder-row.root-row")).toHaveCount(0);
	await sidebar.locator(".folder-main").filter({ hasText: /^empty$/ }).click();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("empty");
	await expect(heading).not.toHaveAttribute("aria-current");
	await heading.click();
	await expect(heading).toHaveAttribute("aria-current", "location");
	await expect(browser.locator(".browser-tile-name")).toHaveText(["empty", "notes.md"]);
	await sidebar.getByRole("button", { name: "Favorites", exact: true }).click();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("Favorites");
	await heading.click();
	await expect(heading).toHaveAttribute("aria-current", "location");
	await sidebar.getByRole("button", { name: "Tags", exact: true }).click();
	await sidebar.getByRole("button", { name: "Picked", exact: true }).click();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("Picked");
	await heading.focus();
	await heading.press("Enter");
	await expect(heading).toHaveAttribute("aria-current", "location");
	await expect(browser.locator(".browser-tile-name")).toHaveText(["empty", "notes.md"]);
});
