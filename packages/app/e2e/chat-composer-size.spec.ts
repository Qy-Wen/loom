import { expect, test } from "./loom.ts";

test("the empty chat editor fits its placeholder and only scrolls after its text reaches the height limit", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const editor = page.getByTestId("chat-composer-editor");
	const dimensions = () => editor.evaluate((element) => ({
		height: element.clientHeight,
		overflow: element.scrollHeight - element.clientHeight,
	}));
	await expect(editor).toHaveAttribute("data-empty", "true");
	const { minHeight, lineAndPadding } = await editor.evaluate((element) => {
		const { minHeight, lineHeight, paddingTop, paddingBottom } = getComputedStyle(element);
		return { minHeight: parseFloat(minHeight), lineAndPadding: parseFloat(lineHeight) + parseFloat(paddingTop) + parseFloat(paddingBottom) };
	});
	expect(minHeight).toBeGreaterThanOrEqual(lineAndPadding);
	await expect.poll(async () => (await dimensions()).overflow).toBe(0);
	const emptyHeight = (await dimensions()).height;
	await editor.click();
	await expect.poll(async () => (await dimensions()).overflow).toBe(0);

	await editor.fill("One line");
	await expect.poll(dimensions).toEqual({ height: emptyHeight, overflow: 0 });
	await editor.press("End");
	await editor.press("Shift+Enter");
	await page.keyboard.insertText("Another line");
	await expect.poll(async () => (await dimensions()).height).toBeGreaterThan(emptyHeight);
	await expect.poll(async () => (await dimensions()).overflow).toBe(0);

	await editor.fill(Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n"));
	await expect.poll(async () => (await dimensions()).overflow).toBeGreaterThan(0);
	await editor.fill("");
	await expect(editor).toHaveAttribute("data-empty", "true");
	await expect.poll(dimensions).toEqual({ height: emptyHeight, overflow: 0 });
});

test("newline shortcuts move the caret to the next line of an empty chat editor", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const editor = page.getByTestId("chat-composer-editor");
	const height = () => editor.evaluate((element) => element.clientHeight);
	const emptyHeight = await height();
	for (const shortcut of ["Control+Enter", "Meta+Enter", "Shift+Enter"]) {
		await editor.fill("");
		await editor.press(shortcut);
		await expect.poll(height).toBeGreaterThan(emptyHeight);
		await editor.press("Backspace");
		await expect.poll(height).toBe(emptyHeight);
		await editor.press(shortcut);
		await page.keyboard.insertText("Second line");
		expect(await editor.innerText()).toBe("\nSecond line");
	}
});
