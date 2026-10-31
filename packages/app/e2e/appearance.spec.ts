import { expect, test } from "./loom.ts";

/** Playwright pins every page to light unless told otherwise; hand the media query back to the app. */
async function followApp(page: import("@playwright/test").Page): Promise<void> {
	await page.emulateMedia({ colorScheme: null });
}

test("Appearance switches the whole window between light and dark and keeps the choice", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "needs control of the main process");
	await followApp(loomPage);
	const original = await loomPage.evaluate(() => window.loom.getGeneralSettings());
	const paint = () => loomPage.evaluate(() => ({
		theme: document.documentElement.dataset.theme,
		hasDarkClass: document.documentElement.classList.contains("dark"),
		page: getComputedStyle(document.body).backgroundColor,
		text: getComputedStyle(document.body).color,
		scheme: getComputedStyle(document.documentElement).colorScheme,
	}));
	try {
		await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settings = loomPage.locator(".settings-dialog");
		await settings.getByRole("tab", { name: "General", exact: true }).click();
		const group = settings.getByRole("radiogroup", { name: "Light or dark interface", exact: true });

		await group.getByRole("radio", { name: "Dark", exact: true }).locator("..").click();
		await expect.poll(async () => (await paint()).theme).toBe("dark");
		const dark = await paint();
		expect(dark).toMatchObject({ hasDarkClass: true, scheme: "dark", page: "rgb(24, 24, 23)", text: "rgb(236, 236, 233)" });
		expect((await loomPage.evaluate(() => window.loom.getGeneralSettings())).appearance).toBe("dark");
		// Native chrome follows: the window background the user sees before and behind the page.
		expect(await electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase())).toBe("#181817");

		await group.getByRole("radio", { name: "Light", exact: true }).locator("..").click();
		await expect.poll(async () => (await paint()).theme).toBe("light");
		expect(await paint()).toMatchObject({ hasDarkClass: false, scheme: "light", page: "rgb(247, 247, 245)", text: "rgb(32, 33, 36)" });
		expect(await electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase())).toBe("#f7f7f5");

		// "Follow system" hands control back to the operating system.
		await group.getByRole("radio", { name: "Follow system", exact: true }).locator("..").click();
		await expect.poll(async () => (await loomPage.evaluate(() => window.loom.getGeneralSettings())).appearance).toBe("system");
		const source = await electronApp!.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
		expect(source).toBe("system");
		const osDark = await electronApp!.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
		await expect.poll(async () => (await paint()).theme).toBe(osDark ? "dark" : "light");
	} finally {
		await loomPage.evaluate((settings) => window.loom.saveGeneralSettings(settings), original);
	}
});

test("a saved dark choice is applied on reload, including the third-party chat widget", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "needs control of the main process");
	await followApp(loomPage);
	const original = await loomPage.evaluate(() => window.loom.getGeneralSettings());
	try {
		await loomPage.evaluate(() => window.loom.saveGeneralSettings({ appearance: "dark" }));
		await loomPage.reload();
		await followApp(loomPage);
		await expect.poll(() => loomPage.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
		// The chat is a third-party widget; it must be dark too, not a white box in a dark window.
		const widget = loomPage.locator("[data-copilotkit]").first();
		await expect(widget).toBeVisible();
		await expect.poll(() => widget.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(37, 37, 35)");
	} finally {
		await loomPage.evaluate((settings) => window.loom.saveGeneralSettings(settings), original);
	}
});
