import { expect, test } from "./loom.ts";

test("double-click renames a session tab and its title survives reload", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const strip = page.getByRole("tablist", { name: "Sessions" });
	const tabs = strip.getByRole("tab");
	const input = strip.getByRole("textbox", { name: "Rename session" });
	const titled = (name: string) => strip.getByRole("tab", { name, exact: true });
	await expect(tabs).toHaveCount(1);
	await page.getByRole("button", { name: "New session", exact: true }).click();
	await expect(tabs).toHaveCount(2);
	await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

	await tabs.last().click({ button: "right" });
	await expect(input).toHaveCount(0);
	await tabs.last().dblclick();
	await expect(input).toBeFocused();
	await expect(input).toHaveValue("New session");
	await input.fill("   素材研究   ");
	await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
	await expect(input).toBeFocused();
	await input.press("Enter");
	await expect(titled("素材研究")).toBeFocused();
	await expect(titled("素材研究")).toHaveAttribute("aria-selected", "true");

	await titled("素材研究").press("F2");
	await expect(input).toHaveValue("素材研究");
	await input.fill("Discard this");
	await input.press("Escape");
	await expect(titled("素材研究")).toBeFocused();

	await titled("素材研究").press("F2");
	await input.fill("   ");
	await input.press("Enter");
	await expect(titled("素材研究")).toBeFocused();

	await titled("素材研究").press("F2");
	await input.fill("Research notes");
	await tabs.first().click();
	await expect(titled("Research notes")).toHaveAttribute("aria-selected", "false");
	await page.reload();
	await expect(titled("Research notes")).toBeVisible();
	await expect(titled("Research notes")).toHaveAttribute("aria-selected", "false");
});
