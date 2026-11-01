import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

for (const platform of ["mac", "windows"] as const) {
	test(`graph help shows ${platform} controls without crowding the caption`, async ({ loomPage, electronApp }) => {
		await expect(loomPage.getByRole("button", { name: "Settings", exact: true })).toBeVisible({ timeout: 30_000 });
		const userData = await electronApp!.evaluate(() => process.env.LOOM_E2E_USER_DATA as string);
		const root = (JSON.parse(await readFile(join(userData, "last-library.json"), "utf8")) as { rootPath: string }).rootPath;
		await writeFile(join(root, "help.md"), "Graph help fixture");
		// Exercise both sets of instructions on either host OS.
		await loomPage.evaluate((platform) => {
			Object.defineProperty(navigator, "userAgent", {
				value: platform === "mac" ? "Macintosh" : "Windows NT",
				configurable: true,
			});
		}, platform);
		await loomPage.locator(".library-views").getByRole("button", { name: "Graph", exact: true }).click();
		await expect(loomPage.locator(".graph-node")).toHaveCount(1, { timeout: 15_000 });

		const caption = loomPage.locator(".graph-caption-summary > span");
		await expect(caption).toHaveText("1 assets · 0 relations");
		const button = loomPage.getByRole("button", { name: "Graph controls", exact: true });
		const help = loomPage.getByRole("dialog", { name: "Graph controls", exact: true });
		await expect(button).toHaveAttribute("aria-expanded", "false");
		await expect(help).toHaveCount(0);
		await button.click();
		await expect(button).toHaveAttribute("aria-expanded", "true");
		await expect(help).toBeVisible();
		await expect(help).toBeFocused();
		await expect(help.locator("dt")).toHaveText([
			"Move a node", "Create a relation", "Pan the canvas", "Zoom the canvas",
			"Box-select nodes", "Add to selection", "Clear selection", "Remove a relation",
		]);
		await expect(help).toContainText("middle mouse button");
		await expect(help).toContainText("Shift");
		await expect(help).toContainText(platform === "mac" ? "hold ⌘ and scroll" : "Hold Ctrl and scroll");
		await expect(help).toContainText(platform === "mac" ? "Shift or ⌘" : "Shift or Ctrl");
		await expect(help).not.toContainText(platform === "mac" ? "Ctrl" : "⌘");

		// The popover fits the graph pane and its scrolling does not pan the canvas underneath.
		const area = (await loomPage.locator(".graph-view").boundingBox())!;
		const box = (await help.boundingBox())!;
		expect(box.x).toBeGreaterThanOrEqual(area.x);
		expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
		const world = loomPage.locator(".graph-world > g").first();
		const before = await world.getAttribute("transform");
		await help.hover();
		await loomPage.mouse.wheel(0, 100);
		expect(await world.getAttribute("transform")).toBe(before);
		await expect(loomPage.locator(".graph-box")).toHaveCount(0);

		await loomPage.keyboard.press("Escape");
		await expect(help).toHaveCount(0);
		await expect(button).toBeFocused();
		await loomPage.keyboard.press("Space");
		await expect(help).toBeVisible();
		await help.getByRole("button", { name: "Close graph help" }).click();
		await expect(help).toHaveCount(0);
		await expect(button).toBeFocused();

		await button.click();
		await button.click();
		await expect(help).toHaveCount(0);
		await button.click();
		await caption.click();
		await expect(help).toHaveCount(0);

		// This is a non-modal popover: tabbing out closes it instead of trapping focus.
		await button.click();
		await loomPage.keyboard.press("Tab");
		await expect(help.getByRole("button", { name: "Close graph help" })).toBeFocused();
		await loomPage.keyboard.press("Tab");
		await expect(help).toHaveCount(0);
	});
}
