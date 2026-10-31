import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test } from "./loom.ts";

async function checkSuggestions(suggest: Locator, first: string, second: string): Promise<void> {
	const input = suggest.getByRole("textbox");
	const toggle = suggest.locator(".suggest-toggle");
	const options = suggest.getByRole("option");
	await input.click();
	await expect(input).toHaveAttribute("aria-expanded", "true");
	await expect(options).toHaveText([first, second]);
	await toggle.click();
	await expect(input).toHaveAttribute("aria-expanded", "false");
	await expect(input).toBeFocused();
	// Clicking an already-focused input must reopen the list, not wait for a new focus event.
	await input.click();
	await expect(options).toHaveCount(2);
	await toggle.click();
	await toggle.click();
	await expect(options).toHaveCount(2);
	await input.press("Escape");
	await expect(options).toHaveCount(0);
	await input.press("ArrowDown");
	await expect(options).toHaveCount(2);
	await input.press("Escape");
	await input.fill(second.slice(0, 3));
	await expect(options).toHaveText([second]);
	await options.click();
	await expect(input).toHaveValue(second);
	await expect(options).toHaveCount(0);
	await input.click();
	await expect(options).toHaveText([second]);
	await input.press("Escape");
}

test("tag and relationship suggestions share click, typing, toggle and keyboard behavior without opening on autofocus", async ({ loomPage: page }) => {
	await expect(page.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await writeFile(join(root, "a.txt"), "a");
	await writeFile(join(root, "b.txt"), "b");
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(2);
	await page.evaluate(async () => {
		const { assets } = await window.loom.getLibrarySnapshot();
		const a = assets.find((asset) => asset.filename === "a.txt")!;
		const b = assets.find((asset) => asset.filename === "b.txt")!;
		await window.loom.addAssetTag(b.assetId, "Alpha");
		await window.loom.addAssetTag(b.assetId, "Beta");
		await window.loom.createRelation(a.assetId, b.assetId, "ALPHA");
		await window.loom.createRelation(a.assetId, b.assetId, "BETA");
	});
	await page.reload();
	await page.locator(".asset-row").filter({ hasText: "a.txt" }).click();
	await page.locator('.panel-tabs button[data-tab="details"]').click();
	const details = page.locator(".details-content");
	const tags = details.locator(".tag-add .suggest");
	await checkSuggestions(tags, "Alpha", "Beta");
	// Leaving the component closes suggestions, and keyboard refocus opens them again.
	await tags.getByRole("textbox").fill("");
	await details.getByRole("button", { name: "Add relation", exact: true }).click();
	await expect(tags.getByRole("option")).toHaveCount(0);
	const relation = details.locator(".relation-type-row .suggest");
	await expect(relation.getByRole("textbox")).toBeFocused();
	await expect(relation.getByRole("textbox")).toHaveAttribute("aria-expanded", "false");
	await expect(relation.getByRole("option")).toHaveCount(0);
	await checkSuggestions(relation, "ALPHA", "BETA");
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(relation.getByRole("option")).toHaveText(["BETA"]);
});

test("inputs without suggestions remain editable without an empty dropdown or toggle", async ({ loomPage: page }) => {
	await expect(page.getByText("Loom", { exact: true })).toBeVisible({ timeout: 30_000 });
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	await writeFile(join(root, "empty.txt"), "empty");
	await page.locator(".asset-row").filter({ hasText: "empty.txt" }).click();
	await page.locator('.panel-tabs button[data-tab="details"]').click();
	const suggest = page.locator(".tag-add .suggest");
	const input = suggest.getByRole("textbox");
	await input.click();
	await input.fill("A new tag");
	await expect(input).toHaveValue("A new tag");
	await expect(input).toHaveAttribute("aria-expanded", "false");
	await expect(suggest.locator(".suggest-toggle, .suggest-list")).toHaveCount(0);
});
