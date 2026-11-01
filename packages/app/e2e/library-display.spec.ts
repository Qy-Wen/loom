import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("icon grids grow tiles to fill available width and add columns without overflowing indented grids", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	await expect(loomPage.locator(".library-sidebar")).toBeVisible();
	const measurements = await loomPage.evaluate(() => {
		const host = document.createElement("div");
		host.style.cssText = "position:absolute;left:-10000px;top:0";
		document.body.append(host);
		try {
			return [60, 80, 150, 160, 180, 190, 240, 320].flatMap((width) => [0, 14, 28].map((indent) => {
				host.style.width = `${width}px`;
				host.innerHTML = `<div class="asset-icon-grid" style="margin-left:${indent}px">${'<div class="asset-icon"><button class="asset-icon-button"></button><span class="asset-icon-name">file.png</span></div>'.repeat(4)}</div>`;
				const grid = host.firstElementChild!, bounds = grid.getBoundingClientRect();
				const sizes = [...grid.querySelectorAll(".asset-icon-button")].map((button) => {
					const box = button.getBoundingClientRect();
					return { width: box.width, height: box.height, top: box.top, right: box.right, overflows: box.left < bounds.left || box.right > bounds.right };
				});
				const row = sizes.filter((size) => size.top === sizes[0]!.top);
				// Removing files must not stretch the remaining tile across the empty columns.
				while (grid.children.length > 1) grid.lastElementChild!.remove();
				const singleWidth = grid.querySelector(".asset-icon-button")!.getBoundingClientRect().width;
				return { width, indent, sizes, columns: row.length, rightGap: bounds.right - row.at(-1)!.right, singleWidth };
			}));
		} finally { host.remove(); }
	});
	for (const measurement of measurements) {
		for (const size of measurement.sizes) {
			expect(size.width).toBeGreaterThan(0);
			expect(size.width).toBeCloseTo(measurement.sizes[0]!.width, 1);
			expect(size.height).toBeCloseTo(size.width, 1);
			expect(size.overflows).toBe(false);
		}
		expect(measurement.rightGap).toBeCloseTo(0, 1);
		expect(measurement.singleWidth).toBeCloseTo(measurement.sizes[0]!.width, 1);
	}
	const at = (width: number) => measurements.find((measurement) => measurement.width === width && measurement.indent === 0)!;
	expect(at(190).columns).toBe(at(180).columns);
	expect(at(190).sizes[0]!.width).toBeGreaterThan(at(180).sizes[0]!.width);
	expect(at(240).columns).toBeGreaterThan(at(190).columns);
	expect(at(240).sizes[0]!.width).toBeLessThan(at(190).sizes[0]!.width);
});

test("favorites and tagged files follow list/icon mode while keeping headings, selection, actions and filtering", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	test.setTimeout(60_000);
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await mkdir(join(root, "nested"));
	await copyFile(new URL("../../core/tests/fixtures/media/still.png", import.meta.url), join(root, "nested", "alpha.png"));
	await writeFile(join(root, "beta.md"), "# beta");
	await writeFile(join(root, "notes.md"), "# notes");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(3);
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		const alpha = assets.find((asset) => asset.filename === "alpha.png")!, beta = assets.find((asset) => asset.filename === "beta.md")!, notes = assets.find((asset) => asset.filename === "notes.md")!;
		await window.loom.setFavorite(alpha.assetId, true); await window.loom.setFavorite(notes.assetId, true);
		await window.loom.addAssetTag(alpha.assetId, "Picked"); await window.loom.addAssetTag(notes.assetId, "Picked");
		await window.loom.addAssetTag(beta.assetId, "Other");
	});
	const sidebar = loomPage.locator(".library-sidebar");
	const favorites = sidebar.locator(".favorites"), tags = sidebar.locator(".library-tags");
	const picked = tags.locator(":scope > div").filter({ has: loomPage.locator(".folder-main").filter({ hasText: /^Picked$/ }) });
	const other = tags.locator(":scope > div").filter({ has: loomPage.locator(".folder-main").filter({ hasText: /^Other$/ }) });
	const display = sidebar.getByRole("group", { name: "File display", exact: true });
	const strip = loomPage.getByRole("tablist", { name: "Open files" });
	const checkHeadings = async () => {
		await expect(favorites.getByRole("button", { name: "Favorites", exact: true })).toHaveAttribute("aria-expanded", "true");
		await expect(tags.getByRole("button", { name: "Tags", exact: true })).toHaveAttribute("aria-expanded", "true");
		await expect(picked.locator(".folder-chevron")).toHaveAttribute("aria-label", "Collapse tag");
		await expect(other.locator(".folder-chevron")).toHaveAttribute("aria-label", "Expand tag");
	};
	await expect(display.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
	await favorites.getByRole("button", { name: "Favorites", exact: true }).click();
	await tags.getByRole("button", { name: "Tags", exact: true }).click();
	await picked.locator(".folder-main").click();
	await expect(favorites.locator(".asset-row")).toHaveCount(2); await expect(picked.locator(".asset-row")).toHaveCount(2);
	await expect(other.locator(".asset-row, .asset-icon")).toHaveCount(0);
	await checkHeadings();
	await display.getByRole("button", { name: "Icons", exact: true }).click();
	await expect(favorites.locator(".asset-icon")).toHaveCount(2); await expect(picked.locator(".asset-icon")).toHaveCount(2);
	await expect(favorites.locator(".asset-row")).toHaveCount(0); await expect(picked.locator(".asset-row")).toHaveCount(0);
	await expect(sidebar.locator(".asset-list > .asset-icon-grid .asset-icon")).toHaveCount(2);
	await checkHeadings();
	// Shared tiles retain thumbnails, names and favorite markers. Tag indentation does not overflow the sidebar.
	await expect(favorites.locator('.asset-icon-name[title="nested/alpha.png"]')).toHaveText("alpha.png");
	await expect(favorites.locator(".asset-thumbnail")).toHaveCount(2);
	await expect(favorites.locator(".asset-favorite")).toHaveCount(2); await expect(picked.locator(".asset-favorite")).toHaveCount(2);
	const grid = (await picked.locator(".asset-icon-grid").boundingBox())!, section = (await tags.boundingBox())!;
	expect(grid.x).toBeGreaterThan(section.x); expect(grid.x + grid.width).toBeLessThanOrEqual(section.x + section.width + 1);
	const icon = (area: typeof favorites, name: string) => area.locator(".asset-icon").filter({ hasText: name }).locator(".asset-icon-button");
	const scrollTop = await sidebar.locator(".asset-list").evaluate((element) => element.scrollTop);
	await icon(favorites, "alpha.png").click();
	await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");
	await expect(picked.locator(".asset-icon").filter({ hasText: "alpha.png" })).toHaveClass(/selected/);
	expect(await sidebar.locator(".asset-list").evaluate((element) => element.scrollTop)).toBe(scrollTop);
	await icon(picked, "notes.md").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
	await expect(favorites.locator(".asset-icon.selected")).toHaveCount(2);
	await icon(favorites, "alpha.png").click();
	await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");
	await icon(picked, "notes.md").click({ button: "middle" });
	await expect(strip.getByRole("tab")).toHaveText(["alpha.png", "notes.md"]);
	// Right-click uses the same file action and leaves the active tab unchanged.
	await electronApp!.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & { shortcutContextId: string };
		state.shortcutContextId = "";
		ipcMain.removeHandler("loom:showAssetContextMenu");
		ipcMain.handle("loom:showAssetContextMenu", (_event, id: string) => { state.shortcutContextId = id; return null; });
	});
	await icon(favorites, "alpha.png").click({ button: "right" });
	await expect.poll(() => electronApp!.evaluate(() => (globalThis as typeof globalThis & { shortcutContextId: string }).shortcutContextId)).toBe((await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.find((asset) => asset.filename === "alpha.png")!.assetId);
	await expect(strip.getByRole("tab", { selected: true })).toHaveText("notes.md");
	await display.getByRole("button", { name: "List", exact: true }).click();
	await expect(favorites.locator(".asset-row")).toHaveCount(2); await expect(picked.locator(".asset-row")).toHaveCount(2);
	await expect(favorites.locator(".asset-icon-grid")).toHaveCount(0); await checkHeadings();
	await favorites.locator(".asset-row").filter({ hasText: "alpha.png" }).click();
	await expect(strip.getByRole("tab", { selected: true })).toHaveText("alpha.png");
	await display.getByRole("button", { name: "Icons", exact: true }).click();
	await expect.poll(() => loomPage.evaluate(() => localStorage.getItem("loom.library.fileDisplay"))).toBe("icons");
	// Searching auto-expands matching shortcut groups, and clearing it restores their manual folds.
	await sidebar.getByRole("button", { name: "Search files", exact: true }).click();
	const search = sidebar.locator(".file-search input");
	await search.fill("beta");
	await expect(favorites).toHaveCount(0); await expect(picked).toHaveCount(0);
	await expect(other.locator(".asset-icon")).toHaveCount(1);
	await search.fill("no-match"); await expect(tags.locator(".asset-icon-grid")).toHaveCount(0);
	await search.fill(""); await checkHeadings();
	await expect(favorites.locator(".asset-icon")).toHaveCount(2); await expect(picked.locator(".asset-icon")).toHaveCount(2);
	const nested = sidebar.locator(".folder-row").filter({ hasText: /^nested$/ });
	if (!(await nested.locator(".folder-chevron").evaluate((button) => button.classList.contains("expanded")))) await nested.locator(".folder-main").click();
	await expect(sidebar.locator(".asset-icon-button")).toHaveCount(7);
	// Favorites, tags, root files and nested files keep square tiles as their available widths differ.
	for (const button of await sidebar.locator(".asset-icon-button").all()) {
		const box = (await button.boundingBox())!;
		expect(box.width).toBeGreaterThanOrEqual(68);
		expect(box.height).toBeCloseTo(box.width, 1);
	}
	await loomPage.reload();
	await expect(display.getByRole("button", { name: "Icons", exact: true })).toHaveAttribute("aria-pressed", "true");
	await favorites.getByRole("button", { name: "Favorites", exact: true }).click();
	await tags.getByRole("button", { name: "Tags", exact: true }).click(); await picked.locator(".folder-main").click();
	await expect(favorites.locator(".asset-icon")).toHaveCount(2); await expect(picked.locator(".asset-icon")).toHaveCount(2);
});
