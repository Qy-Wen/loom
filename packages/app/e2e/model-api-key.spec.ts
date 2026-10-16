import { expect, test } from "./loom.ts";

test("non-Chat API key buttons edit masked drafts with cancel, confirm and clearing", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
	const slots = ["Text embedding", "Rerank", "VLM", "Audio"];
	const savedBefore = await loomPage.evaluate(() => window.loom.getModelSettings());
	for (const title of slots) {
		const slot = settings.getByRole("group", { name: title, exact: true });
		const label = `${title} API key`;
		const button = slot.getByRole("button", { name: label, exact: true });
		await expect(slot.getByRole("textbox", { name: label, exact: true })).toHaveCount(0);
		await button.click();
		const dialog = loomPage.getByRole("dialog", { name: label, exact: true });
		const input = dialog.getByLabel(label, { exact: true });
		await expect(input).toHaveAttribute("type", "password");
		const original = await input.inputValue();
		await input.fill("discard-this-key");
		await input.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(settings).toBeVisible();
		await expect(button).toBeFocused();
		await button.click();
		await expect(input).toHaveValue(original);
		await input.fill(`test-${title}-key`);
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await button.click();
		await expect(input).toHaveValue(original);
		await input.fill(`test-${title}-key`);
		await input.press("Enter");
		await expect(dialog).toHaveCount(0);
		await expect(settings).toBeVisible();
		await button.click();
		await expect(input).toHaveValue(`test-${title}-key`);
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	}
	// Confirming the dialog must not invoke the outer Settings form's Save.
	expect(await loomPage.evaluate(() => window.loom.getModelSettings())).toEqual(savedBefore);
	await settings.getByRole("button", { name: "Save", exact: true }).click();
	await expect(settings).toHaveCount(0);
	const saved = await loomPage.evaluate(() => window.loom.getModelSettings());
	for (const id of ["embedding", "rerank", "vlm", "audio"] as const) {
		expect(saved[id].apiKey).toBe(`test-${slots[["embedding", "rerank", "vlm", "audio"].indexOf(id)]}-key`);
	}
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	await settings.getByRole("group", { name: "Text embedding", exact: true }).getByRole("button", { name: "Text embedding API key", exact: true }).click();
	const dialog = loomPage.getByRole("dialog", { name: "Text embedding API key", exact: true });
	await dialog.getByLabel("Text embedding API key", { exact: true }).fill("");
	await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
	await settings.getByRole("button", { name: "Save", exact: true }).click();
	expect((await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.apiKey).toBe("");
});
