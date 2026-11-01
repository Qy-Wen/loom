import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("favorites/tags and files scroll independently, resize with bounds, and preserve a content-sized preference", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const root = (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(join(root, `item-${String(i).padStart(2, "0")}.md`), `# item ${i}`)));
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(40);
	await loomPage.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		for (const asset of assets.slice(0, 12)) {
			await window.loom.setFavorite(asset.assetId, true); await window.loom.addAssetTag(asset.assetId, "Picked");
		}
	});
	const sidebar = loomPage.locator(".library-sidebar");
	const top = sidebar.locator(".library-shortcuts"), files = sidebar.locator(".asset-list");
	const separator = sidebar.getByRole("separator", { name: "Resize favorites/tags and file tree", exact: true });
	const height = async () => Number(await separator.getAttribute("aria-valuenow"));
	const scroll = (area: typeof top) => area.evaluate((element) => element.scrollTop);
	const extent = async () => (await sidebar.locator(".library-scroll-regions").evaluate((element) => element.clientHeight)) - (await sidebar.locator(".library-files-header").boundingBox())!.height - (await separator.boundingBox())!.height;
	const ratio = () => loomPage.evaluate(() => Number(localStorage.getItem("loom.library.shortcutFraction")));
	const moreCue = sidebar.locator(".library-shortcuts-more");
	await expect(separator).toBeVisible();
	await expect(separator).toHaveCSS("height", "12px");
	await expect(moreCue).toHaveCount(0); // Folded headings fit; don't suggest that hidden content exists.
	await top.getByRole("button", { name: "Favorites", exact: true }).click();
	await expect.poll(async () => Math.abs(await height() - await extent() * 0.4)).toBeLessThanOrEqual(1);
	await expect(moreCue).toBeVisible();
	await expect(moreCue).toHaveCSS("pointer-events", "none");
	await expect(moreCue).toHaveCSS("height", "30px");
	await expect(moreCue.locator("svg")).toHaveCount(0);
	await expect(separator).toHaveAttribute("title", "More favorites/tags below. Scroll down or drag the divider.");
	await expect(separator).toHaveAttribute("aria-description", "More favorites/tags below. Scroll down or drag the divider.");
	await expect(top).toHaveCSS("overflow-y", "auto"); await expect(files).toHaveCSS("overflow-y", "auto");
	await expect(top).toHaveCSS("overscroll-behavior-y", "contain");
	const scrollbarStyle = (area: typeof top) => area.evaluate((element) => {
		const width = getComputedStyle(element, "::-webkit-scrollbar").width;
		const thumb = getComputedStyle(element, "::-webkit-scrollbar-thumb");
		return { width, color: thumb.backgroundColor, visibleWidth: parseFloat(width) - parseFloat(thumb.borderLeftWidth) - parseFloat(thumb.borderRightWidth) };
	});
	const expectedScrollbar = { width: "8px", color: "rgb(196, 198, 200)", visibleWidth: 5 };
	// Measure the idle color with the pointer outside both scrollports.
	await loomPage.mouse.move(600, 20);
	expect(await scrollbarStyle(top)).toEqual(expectedScrollbar);
	expect(await scrollbarStyle(files)).toEqual(expectedScrollbar);
	// The shortcuts pane is not a root import/drop target.
	expect(await top.evaluate((element) => {
		const transfer = new DataTransfer(); transfer.items.add(new File(["hello"], "drop.txt", { type: "text/plain" }));
		const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
		element.dispatchEvent(event); return event.defaultPrevented;
	})).toBe(false);
	const topBounds = (await top.boundingBox())!;
	await loomPage.mouse.move(topBounds.x + 60, topBounds.y + 60); await loomPage.mouse.wheel(0, 100);
	await expect.poll(() => scroll(top)).toBeGreaterThan(0); expect(await scroll(files)).toBe(0);
	await loomPage.mouse.move(600, 20);
	expect(await scrollbarStyle(top)).toEqual(expectedScrollbar);
	expect(await scrollbarStyle(files)).toEqual(expectedScrollbar);
	await top.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(moreCue).toHaveCount(0);
	await expect(separator).not.toHaveClass(/has-more/);
	const bottomedTop = await scroll(top);
	await loomPage.mouse.wheel(0, 300); await loomPage.waitForTimeout(150);
	expect(await scroll(files)).toBe(0); // Wheel at the upper boundary cannot chain into the file tree.
	const filesBounds = (await files.boundingBox())!;
	const heading = sidebar.locator(".library-files-heading");
	const headingBounds = (await heading.boundingBox())!;
	await loomPage.mouse.move(filesBounds.x + 60, filesBounds.y + 80); await loomPage.mouse.wheel(0, 200);
	await expect.poll(() => scroll(files)).toBeGreaterThan(0); expect(await scroll(top)).toBe(bottomedTop);
	expect((await heading.boundingBox())!.y).toBe(headingBounds.y); // File tools stay above their scrollport.
	// Navigating a file only scrolls its own region, not the shortcuts above it.
	await files.locator(".asset-row").filter({ hasText: "item-39.md" }).click();
	expect(await scroll(top)).toBe(bottomedTop);
	const initial = await height();
	const handle = (await separator.boundingBox())!;
	await loomPage.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await loomPage.mouse.down();
	await loomPage.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + 50, { steps: 6 }); await loomPage.mouse.up();
	await expect.poll(() => height()).toBe(initial + 50);
	await expect(loomPage.locator("body")).not.toHaveClass(/library-resizing-regions/);
	await separator.press("Home"); expect(await height()).toBe(Number(await separator.getAttribute("aria-valuemin")));
	await separator.press("ArrowDown"); await expect(separator).toHaveAttribute("aria-valuenow", "74");
	await separator.press("End");
	// Fractional layout bounds can round the value and maximum to adjacent integers.
	expect(Math.abs(await height() - Number(await separator.getAttribute("aria-valuemax")))).toBeLessThanOrEqual(1);
	expect((await files.boundingBox())!.height).toBeGreaterThanOrEqual(120);
	await top.evaluate((element) => { element.scrollTop = 0; });
	// Expanding the divider to fit all content removes the cue; shrinking it brings the cue back.
	await expect(moreCue).toHaveCount(0);
	await separator.press("Home"); await expect(moreCue).toBeVisible();
	await separator.dblclick(); await expect.poll(() => ratio()).toBe(0.4);
	await separator.press("ArrowDown"); const preferred = await ratio();
	// Collapsing shortcuts releases space, but expanding restores the preferred cap.
	await top.getByRole("button", { name: "Favorites", exact: true }).click();
	await expect.poll(() => height()).toBeLessThan(80); expect(await ratio()).toBe(preferred);
	await expect(moreCue).toHaveCount(0);
	// With nothing to adjust, the divider is inert: no resize cursor, not focusable, and dragging does nothing.
	await expect(separator).toHaveClass(/is-fixed/); await expect(separator).toHaveAttribute("aria-disabled", "true");
	await expect(separator).not.toHaveAttribute("tabindex"); await expect(separator).toHaveCSS("cursor", "default");
	const folded = await height(), fixedBox = (await separator.boundingBox())!;
	await loomPage.mouse.move(fixedBox.x + fixedBox.width / 2, fixedBox.y + fixedBox.height / 2); await loomPage.mouse.down();
	await expect(loomPage.locator("body")).not.toHaveClass(/library-resizing-regions/);
	await loomPage.mouse.move(fixedBox.x + fixedBox.width / 2, fixedBox.y + fixedBox.height / 2 + 80, { steps: 4 }); await loomPage.mouse.up();
	expect(await height()).toBe(folded); expect(await ratio()).toBe(preferred);
	await top.getByRole("button", { name: "Favorites", exact: true }).click();
	await expect.poll(async () => Math.abs(await height() - await extent() * preferred)).toBeLessThanOrEqual(1);
	await expect(moreCue).toBeVisible();
	// Window resize and sidebar hiding do not overwrite the stored preference.
	await electronApp!.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0]!; const [width] = window.getSize(); window.setSize(width, 500);
	});
	await expect.poll(async () => Math.abs(await height() - await extent() * preferred)).toBeLessThanOrEqual(1);
	await loomPage.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
	await loomPage.getByRole("button", { name: "Expand sidebar", exact: true }).click();
	expect(await ratio()).toBe(preferred);
	await loomPage.reload(); await top.getByRole("button", { name: "Favorites", exact: true }).click();
	await expect.poll(async () => Math.abs(await height() - await extent() * preferred)).toBeLessThanOrEqual(1);
	await top.getByRole("button", { name: "Tags", exact: true }).click();
	await top.locator(".folder-main").filter({ hasText: /^Picked$/ }).click();
	await expect(top.locator(".library-tags .asset-row")).toHaveCount(12);
	await top.evaluate((element) => { element.scrollTop = 0; });
	await expect(moreCue).toBeVisible();
	await top.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(moreCue).toHaveCount(0);
	await top.evaluate((element) => { element.scrollTop = 0; });
	await expect(moreCue).toBeVisible();
	await expect.poll(async () => Math.abs(await height() - await extent() * preferred)).toBeLessThanOrEqual(1);
	expect(await ratio()).toBe(preferred);
	const box = (await separator.boundingBox())!;
	await loomPage.mouse.move(box.x + box.width / 2, box.y + 3); await loomPage.mouse.down();
	await loomPage.evaluate(() => window.dispatchEvent(new Event("blur")));
	await expect(loomPage.locator("body")).not.toHaveClass(/library-resizing-regions/); await loomPage.mouse.up();
});

test("without shortcuts the file heading and tree get all space and root dragover still accepts imports", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	await expect.poll(async () => (await loomPage.evaluate(() => window.loom.listSessions())).length).toBe(1);
	const sidebar = loomPage.locator(".library-sidebar"), files = sidebar.locator(".asset-list");
	await expect(sidebar.locator(".library-shortcuts, .library-region-handle, .library-shortcuts-more")).toHaveCount(0);
	const region = (await sidebar.locator(".library-scroll-regions").boundingBox())!, tree = (await files.boundingBox())!;
	const header = (await sidebar.locator(".library-files-header").boundingBox())!;
	expect(tree.height + header.height).toBe(region.height);
	// OS-file dragover still targets the root of the lower pane.
	await files.evaluate((element) => {
		const transfer = new DataTransfer(); transfer.items.add(new File(["hello"], "drop.txt", { type: "text/plain" }));
		const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
		element.dispatchEvent(event);
		if (!event.defaultPrevented) throw new Error("root dragover was not accepted");
	});
});
