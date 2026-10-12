import { expect, test } from "./loom.ts";

test("unrelated floating panels split, cancel, resize and restore through the shared engine", async ({ loomPage: page }) => {
	test.skip(process.env.LOOM_E2E_PANELS !== "1" || Boolean(process.env.LOOM_CDP_URL), "build with LOOM_E2E_PANELS=1 for isolated registration acceptance");
	await expect(page.locator(".shell")).toBeVisible();
	await page.evaluate(() => {
		localStorage.setItem("loom.layout.panels", JSON.stringify({ version: 1, opened: ["alpha", "beta", "gamma", "timeline", "inspector"], slots: [
			{ id: "a", tabs: ["alpha", "beta"], active: "alpha", place: { mode: "dock" }, weight: 1 },
			{ id: "g", tabs: ["gamma"], active: "gamma", place: { mode: "dock" }, weight: 1 },
			{ id: "t", tabs: ["timeline"], active: "timeline", place: { mode: "float", x: 450, y: 100, width: 300, height: 250 }, weight: 1 },
			{ id: "i", tabs: ["inspector"], active: "inspector", place: { mode: "float", x: 20, y: 40, width: 330, height: 500 }, weight: 1 },
		] }));
	});
	await page.goto(new URL("panels-fixture.html", page.url()).href);
	const source = page.locator('.work-panel[data-panel="timeline"]');
	const target = page.locator('.work-panel[data-panel="inspector"]');
	try {
		const handle = await source.locator(".work-panel-title").boundingBox();
		const box = await target.boundingBox();
		await page.mouse.move(handle!.x + 80, handle!.y + 18); await page.mouse.down();
		await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height - 12, { steps: 10 });
		await expect(page.locator(".shell.dock-split-target")).toBeVisible(); await page.mouse.up();
		expect((await source.boundingBox())!.y).toBeGreaterThan((await target.boundingBox())!.y);
		const saved = await page.evaluate(() => localStorage.getItem("loom.layout.panels"));
		const moved = await source.locator(".work-panel-title").boundingBox();
		await page.mouse.move(moved!.x + 80, moved!.y + 18); await page.mouse.down();
		await page.mouse.move(600, 250, { steps: 6 });
		await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel")));
		await page.mouse.up();
		expect(await page.evaluate(() => localStorage.getItem("loom.layout.panels"))).toBe(saved);
		const corner = await source.locator("xpath=..").locator(".work-panel-edge.corner").boundingBox();
		const before = await source.boundingBox();
		await page.mouse.move(corner!.x + 5, corner!.y + 5); await page.mouse.down();
		await page.mouse.move(corner!.x + 45, corner!.y + 35); await page.mouse.up();
		expect((await source.boundingBox())!.width).toBeGreaterThan(before!.width);
		const resized = await page.evaluate(() => localStorage.getItem("loom.layout.panels"));
		await page.reload(); await expect(source).toBeVisible();
		expect(await page.evaluate(() => localStorage.getItem("loom.layout.panels"))).toBe(resized);
	} finally { await page.mouse.up(); await page.goto(new URL("index.html", page.url()).href); }
});
