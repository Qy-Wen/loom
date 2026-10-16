import { expect, test } from "./loom.ts";

test("non-Chat API keys save on confirmation, with masked values, cancel and clearing", async ({ loomPage }) => {
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	const settings = loomPage.getByRole("dialog", { name: "Settings", exact: true });
	const rows = [
		{ id: "embedding", title: "Text embedding" }, { id: "rerank", title: "Rerank" },
		{ id: "vlm", title: "VLM" }, { id: "audio", title: "Audio" },
	] as const;
	await expect(settings.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	await expect(settings.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
	for (const { id, title } of rows) {
		const slot = settings.getByRole("group", { name: title, exact: true });
		const label = `${title} API key`;
		const button = slot.getByRole("button", { name: label, exact: true });
		const storedBefore = (await loomPage.evaluate(() => window.loom.getModelSettings()))[id].apiKey;
		await expect(slot.getByRole("textbox", { name: label, exact: true })).toHaveCount(0);
		await button.click();
		const dialog = loomPage.getByRole("dialog", { name: label, exact: true });
		const input = dialog.getByLabel(label, { exact: true });
		await expect(input).toHaveAttribute("type", "password");
		await expect(input).toHaveValue(storedBefore);
		await input.focus();
		expect(await input.evaluate((element) => getComputedStyle(element).boxShadow)).toBe("none");
		await input.fill("discard-this-key");
		await input.press("Escape");
		await expect(dialog).toHaveCount(0); await expect(settings).toBeVisible(); await expect(button).toBeFocused();
		expect((await loomPage.evaluate(() => window.loom.getModelSettings()))[id].apiKey).toBe(storedBefore);
		await button.click(); await expect(input).toHaveValue(storedBefore);
		await input.fill("discard-this-key");
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		expect((await loomPage.evaluate(() => window.loom.getModelSettings()))[id].apiKey).toBe(storedBefore);
		await button.click();
		await input.fill(`test-${title}-key`);
		await dialog.getByRole("button", { name: `Show ${label}`, exact: true }).click();
		await expect(input).toHaveAttribute("type", "text"); await expect(input).toHaveValue(`test-${title}-key`);
		await dialog.getByRole("button", { name: `Hide ${label}`, exact: true }).click();
		await expect(input).toHaveAttribute("type", "password");
		const footer = await dialog.locator(".settings-login-actions").evaluate((element) => {
			const [cancel, confirm] = Array.from(element.querySelectorAll("button")).map((button) => button.getBoundingClientRect());
			return { topDelta: Math.abs(cancel!.top - confirm!.top), heightDelta: Math.abs(cancel!.height - confirm!.height), correctOrder: confirm!.left > cancel!.right };
		});
		expect(footer.topDelta).toBeLessThan(1); expect(footer.heightDelta).toBeLessThan(1); expect(footer.correctOrder).toBe(true);
		await input.press("Enter");
		await expect(dialog).toHaveCount(0); await expect(settings).toBeVisible();
		expect((await loomPage.evaluate(() => window.loom.getModelSettings()))[id].apiKey).toBe(`test-${title}-key`);
	}
	await settings.getByRole("button", { name: "Close settings", exact: true }).click();
	await loomPage.getByRole("button", { name: "Settings", exact: true }).click();
	await settings.getByRole("group", { name: "Text embedding", exact: true }).getByRole("button", { name: "Text embedding API key", exact: true }).click();
	const dialog = loomPage.getByRole("dialog", { name: "Text embedding API key", exact: true });
	const input = dialog.getByLabel("Text embedding API key", { exact: true });
	await expect(input).toHaveValue("test-Text embedding-key"); await expect(input).toHaveAttribute("type", "password");
	await input.fill("");
	await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect((await loomPage.evaluate(() => window.loom.getModelSettings())).embedding.apiKey).toBe("");
	await settings.getByRole("button", { name: "Close settings", exact: true }).click();
});
