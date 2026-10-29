import type { Page } from "@playwright/test";
import { expect, test } from "./loom.ts";

async function setup(page: Page, mode: "dock" | "beside" | "above" | "bottom") {
	await expect(page.locator(".shell")).toBeVisible();
	await page.evaluate((mode) => localStorage.setItem("loom.layout.panels", JSON.stringify({ version: 1,
		opened: ["alpha", "beta", "gamma", "timeline", "inspector"], slots: [
			{ id: "a", tabs: ["alpha", "beta"], active: "alpha", place: { mode }, weight: 1 },
			{ id: "g", tabs: ["gamma"], active: "gamma", place: { mode: "float", x: 300, y: 60, width: 320, height: 260 }, weight: 1 },
			{ id: "t", tabs: ["timeline", "inspector"], active: "timeline", place: { mode }, weight: 1 },
		],
	})), mode);
	await page.goto(new URL("panels-fixture.html", page.url()).href);
	await expect(page.locator('[data-slot="a"]')).toBeVisible();
	return page.evaluate(() => localStorage.getItem("loom.layout.panels"));
}

async function settle(page: Page) {
	await page.evaluate(async () => {
		await Promise.all(document.querySelector(".shell")!.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
	});
}

for (const mode of ["dock", "beside", "above", "bottom"] as const) test(`a ${mode} placeholder animates, keeps its drop zone stable, and restores on cancel`, async ({ loomPage: page }, testInfo) => {
	test.skip(process.env.LOOM_E2E_PANELS !== "1" || Boolean(process.env.LOOM_CDP_URL), "isolated panel fixture build required");
	const saved = await setup(page, mode);
	const target = page.locator('[data-slot="a"]');
	const original = (await target.boundingBox())!;
	const handle = (await page.locator('[data-panel="gamma"] .work-panel-title').boundingBox())!;
	const x = original.x + original.width * 0.65, y = original.y + original.height - 10;
	try {
		await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
		await page.mouse.down();
		await page.mouse.move(550, 180);
		await page.mouse.move(x, y);
		const preview = page.locator(".panel-slot.drop-preview");
		await expect(preview).toBeVisible();
		const motion = await page.evaluate(() => {
			const preview = document.querySelector<HTMLElement>(".panel-slot.drop-preview")!;
			const target = document.querySelector<HTMLElement>('[data-slot="a"]')!;
			const animations = [preview, target].flatMap((element) => element.getAnimations());
			for (const animation of animations) { animation.pause(); animation.currentTime = 60; }
			return { count: animations.length, visual: preview.getBoundingClientRect().height, layout: preview.offsetHeight };
		});
		expect(motion.count).toBe(2);
		expect(motion.visual).toBeGreaterThan(8);
		expect(motion.visual).toBeLessThan(motion.layout);
		await page.screenshot({ path: testInfo.outputPath("placeholder-midway.png") });
		// Move again while the visuals are between positions: the original drop zone still wins.
		await page.mouse.move(x + 1, y);
		await expect(preview).toBeVisible();
		await page.evaluate(() => {
			for (const animation of document.querySelector(".shell")!.getAnimations({ subtree: true })) animation.play();
		});
		await settle(page);
		expect((await target.boundingBox())!.height).toBeCloseTo(original.height / 2, 1);
		await page.screenshot({ path: testInfo.outputPath("placeholder-settled.png") });
		await page.mouse.move(x, original.y + 10);
		await expect(preview).toBeVisible();
		await settle(page);
		expect((await preview.boundingBox())!.y).toBeLessThan((await target.boundingBox())!.y);
		await page.mouse.move(550, 180);
		await expect(preview).toHaveCount(0);
		await settle(page);
		expect((await target.boundingBox())!.height).toBeCloseTo(original.height, 1);
		await page.mouse.move(x, y);
		await expect(preview).toBeVisible();
		await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel")));
		await settle(page);
		expect(await target.boundingBox()).toEqual(original);
		expect(await page.evaluate(() => localStorage.getItem("loom.layout.panels"))).toBe(saved);
	} finally { await page.mouse.up().catch(() => {}); }
});

for (const region of ["dock", "beside"] as const) test(`opening a new ${region} region expands its placeholder horizontally`, async ({ loomPage: page }) => {
	test.skip(process.env.LOOM_E2E_PANELS !== "1" || Boolean(process.env.LOOM_CDP_URL), "isolated panel fixture build required");
	await setup(page, "dock");
	if (region === "dock") {
		await page.evaluate(() => {
			const state = JSON.parse(localStorage.getItem("loom.layout.panels")!);
			for (const slot of state.slots) if (slot.id !== "g") slot.place = { mode: "float", x: 0, y: 300, width: 300, height: 200 };
			localStorage.setItem("loom.layout.panels", JSON.stringify(state));
		});
		await page.reload();
	}
	const handle = (await page.locator('[data-panel="gamma"] .work-panel-title').boundingBox())!;
	const shell = (await page.locator(".shell").boundingBox())!;
	const target = (await page.locator('[data-slot="a"]').boundingBox())!;
	try {
		await page.mouse.move(handle.x + 100, handle.y + 18);
		await page.mouse.down();
		await page.mouse.move(550, 180);
		await page.mouse.move(region === "dock" ? shell.x + shell.width - 8 : target.x + 12, region === "dock" ? shell.y + 180 : target.y + target.height / 2);
		const preview = page.locator(".panel-slot.drop-preview");
		await expect(preview).toBeVisible();
		const size = await preview.evaluate((element) => {
			const animation = element.getAnimations()[0]!;
			animation.pause(); animation.currentTime = 60;
			return { visual: element.getBoundingClientRect().width, layout: (element as HTMLElement).offsetWidth };
		});
		expect(size.visual).toBeGreaterThan(8);
		expect(size.visual).toBeLessThan(size.layout);
		await preview.evaluate((element) => element.getAnimations()[0]!.play());
		await settle(page);
		const landing = await preview.boundingBox();
		await page.mouse.up();
		await expect(page.locator(`[data-panel="gamma"]`)).toHaveClass(new RegExp(`\\b${region}\\b`));
		expect(await page.locator('[data-slot="g"]').boundingBox()).toEqual(landing);
	} finally { await page.mouse.up().catch(() => {}); }
});

test("reduced motion shows the final placeholder immediately and commits the previewed split", async ({ loomPage: page }) => {
	test.skip(process.env.LOOM_E2E_PANELS !== "1" || Boolean(process.env.LOOM_CDP_URL), "isolated panel fixture build required");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await setup(page, "dock");
	const target = page.locator('[data-slot="a"]');
	const original = (await target.boundingBox())!;
	const handle = (await page.locator('[data-panel="gamma"] .work-panel-title').boundingBox())!;
	await page.mouse.move(handle.x + 100, handle.y + 18);
	await page.mouse.down();
	await page.mouse.move(550, 180);
	await page.mouse.move(original.x + original.width * 0.65, original.y + original.height - 10);
	await expect(page.locator(".panel-slot.drop-preview")).toBeVisible();
	expect(await page.locator(".shell").evaluate((shell) => shell.getAnimations({ subtree: true }).length)).toBe(0);
	const preview = await page.locator('[data-slot="g"]').boundingBox();
	await page.mouse.up();
	expect(await page.locator('[data-slot="g"]').boundingBox()).toEqual(preview);
	expect((await target.boundingBox())!.height).toBeCloseTo(original.height / 2, 1);
});
