import { expect, test } from "./loom.ts";

for (const mode of ["dock", "beside", "above", "bottom"] as const) test(`five unrelated registered panels share split/join/resize/hide/reopen rules in ${mode}`, async ({ loomPage: page }) => {
	test.skip(process.env.LOOM_E2E_PANELS !== "1" || Boolean(process.env.LOOM_CDP_URL), "build with LOOM_E2E_PANELS=1 for isolated registration acceptance");
	await expect(page.locator(".shell")).toBeVisible();
	await page.evaluate((mode) => {
		localStorage.setItem("loom.layout.aboveHeight", "440");
		localStorage.setItem("loom.layout.bottomHeight", "440");
		localStorage.setItem("loom.layout.panels", JSON.stringify({ version: 1, opened: ["alpha", "beta", "gamma", "timeline", "inspector"], slots: [
			{ id: "a", tabs: ["alpha", "beta"], active: "alpha", place: { mode }, weight: 1 },
			{ id: "g", tabs: ["gamma"], active: "gamma", place: { mode }, weight: 1 },
			{ id: "t", tabs: ["timeline"], active: "timeline", place: { mode: "float", x: 300, y: 60, width: 320, height: 260 }, weight: 1 },
			{ id: "i", tabs: ["inspector"], active: "inspector", place: { mode }, weight: 1 },
		] }));
	}, mode);
	const url = new URL("panels-fixture.html", page.url()).href;
	await page.goto(url);
	const timeline = page.locator('.work-panel[data-panel="timeline"]');
	const gamma = page.locator('.work-panel[data-panel="gamma"]');
	const handle = await timeline.locator(".work-panel-title").boundingBox();
	const target = await gamma.boundingBox();
	try {
		await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 18); await page.mouse.down();
		await page.mouse.move(target!.x + target!.width * 0.65, target!.y + target!.height - 10, { steps: 12 });
		await page.mouse.move(target!.x + target!.width * 0.65 + 1, target!.y + target!.height - 10);
		await expect(page.locator(".shell.dock-split-target")).toBeVisible();
		await page.mouse.up();
		expect((await timeline.boundingBox())!.y).toBeGreaterThan((await gamma.boundingBox())!.y);
		const region = page.locator(`.panel-region[data-region="${mode}"]`);
		const divider = region.locator(":scope > .resize-handle.row").nth(1);
		const resize = await divider.boundingBox();
		const before = await gamma.boundingBox();
		await page.mouse.move(resize!.x + resize!.width / 2, resize!.y + 5); await page.mouse.down();
		await page.mouse.move(resize!.x + resize!.width / 2, resize!.y + 30); await page.mouse.up();
		expect((await gamma.boundingBox())!.height).toBeGreaterThan(before!.height);
		const detached = await timeline.locator(".work-panel-title").boundingBox();
		await page.mouse.move(detached!.x + detached!.width / 2, detached!.y + 18); await page.mouse.down();
		await page.mouse.move(500, 150, { steps: 8 });
		await expect(timeline).toHaveClass(/\bfloat\b/);
		await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
		const center = await gamma.boundingBox();
		await page.mouse.move(center!.x + center!.width * 0.65, center!.y + center!.height / 2, { steps: 8 });
		await expect(page.locator(".shell.join-target")).toBeVisible(); await page.mouse.up();
		await expect(page.locator(".panel-tabs")).toHaveCount(2);
		await expect(page.locator('.panel-tabs button[data-tab="timeline"]')).toBeVisible();
		const active = page.locator('.panel-tabs button[data-tab="timeline"]');
		const tab = await active.boundingBox();
		const gammaTab = await page.locator('.panel-tabs button[data-tab="gamma"]').boundingBox();
		await page.mouse.move(tab!.x + tab!.width / 2, tab!.y + tab!.height / 2); await page.mouse.down();
		await page.mouse.move(gammaTab!.x + 2, gammaTab!.y + gammaTab!.height / 2, { steps: 6 }); await page.mouse.up();
		const groupTabs = await page.evaluate(() => JSON.parse(localStorage.getItem("loom.layout.panels")!).slots.find((slot: { tabs: string[] }) => slot.tabs.includes("timeline")).tabs);
		expect(groupTabs).toEqual(["timeline", "gamma"]);
		await page.getByRole("button", { name: "Toggle inspector" }).click();
		await expect(page.locator('.work-panel[data-panel="inspector"]')).toHaveCount(0);
		await page.getByRole("button", { name: "Toggle inspector" }).click();
		await expect(page.locator('.work-panel[data-panel="inspector"]')).toBeVisible();
		await page.getByRole("button", { name: "Toggle notes registration" }).click();
		await expect(page.locator('.work-panel[data-panel="notes"]')).toBeVisible();
		await page.getByRole("button", { name: "Toggle notes registration" }).click();
		await expect(page.locator('.work-panel[data-panel="notes"]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("loom.layout.panels")!).slots.some((slot: { tabs: string[] }) => slot.tabs.includes("notes")))).toBe(false);
		const saved = await page.evaluate(() => localStorage.getItem("loom.layout.panels"));
		await page.reload(); await expect(page.locator(".panel-tabs")).toHaveCount(2);
		expect(await page.evaluate(() => localStorage.getItem("loom.layout.panels"))).toBe(saved);
	} finally { await page.mouse.up(); await page.goto(new URL("index.html", page.url()).href); }
});
