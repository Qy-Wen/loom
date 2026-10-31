import { expect, test } from "./loom.ts";

test("workspace view buttons show matching icons and labels, including at the minimum sidebar width", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated renderer required");
	for (const width of [180, 240, 320]) {
		await loomPage.evaluate((width) => localStorage.setItem("loom.layout.libraryWidth", String(width)), width);
		await loomPage.reload();
		const views = loomPage.getByRole("navigation", { name: "Workspace views" });
		await expect(views).toBeVisible();
		await expect(views.getByRole("button")).toHaveText(["Library", "Table", "Graph"]);
		for (const name of ["Library", "Table", "Graph"]) {
			const button = views.getByRole("button", { name, exact: true });
			await button.click();
			await expect(button).toHaveAttribute("aria-pressed", "true");
			await expect(views.locator('[aria-pressed="true"]')).toHaveCount(1);
			await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
			for (const item of await views.getByRole("button").all()) {
				const bounds = (await item.boundingBox())!;
				const icon = (await item.locator("svg").boundingBox())!;
				const label = (await item.locator("span").boundingBox())!;
				expect([icon.width, icon.height]).toEqual([14, 14]);
				expect(icon.x).toBeGreaterThanOrEqual(bounds.x - 1);
				expect(icon.x + icon.width).toBeLessThanOrEqual(label.x);
				expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
				expect(Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2)).toBeLessThan(1);
				const nav = (await views.boundingBox())!;
				expect(bounds.x + bounds.width).toBeLessThanOrEqual(nav.x + nav.width + 1);
			}
		}
	}
});
