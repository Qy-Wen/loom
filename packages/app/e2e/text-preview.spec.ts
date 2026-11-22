import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./loom.ts";

test("text files opened from the library can be previewed, edited and saved", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(root).toBeTruthy();
	const library = (await root())!;
	const json = join(library, "settings.JSON");
	const txt = join(library, "notes.txt");
	await Promise.all([
		writeFile(json, '{"enabled": false}'),
		writeFile(txt, "\uFEFFFirst line\r\nSecond line\r\n"),
		writeFile(join(library, "data.tsv"), "name\tvalue\nhello\tworld\n"),
	]);

	const toolbar = page.getByRole("toolbar", { name: "Text view" });
	const edit = toolbar.getByRole("button", { name: "Edit mode" });
	const preview = toolbar.getByRole("button", { name: "Preview mode" });
	const text = page.locator(".text-preview");
	const open = (filename: string) => page.locator(".library-sidebar .asset-row").filter({ hasText: filename }).click();

	await open("settings.JSON");
	await expect(toolbar.getByRole("button").first()).toHaveAccessibleName("Add to Favorites");
	await expect(text).toHaveText('{"enabled": false}');
	await edit.click();
	const jsonSource = page.getByRole("textbox", { name: "Edit settings.JSON" });
	await expect(jsonSource).toBeFocused();
	await expect(jsonSource.locator("span").filter({ hasText: "false" })).toBeVisible();
	await jsonSource.press("ControlOrMeta+a");
	await page.keyboard.insertText('{"enabled": true }');
	await preview.click();
	await expect(text).toHaveText('{"enabled": true }');
	expect(await readFile(json, "utf8")).toBe('{"enabled": true }');

	await open("notes.txt");
	await expect(text).toContainText("Second line");
	await page.keyboard.press("ControlOrMeta+f");
	await expect(page.locator(".find-bar input")).toBeFocused();
	await edit.click();
	const txtSource = page.getByRole("textbox", { name: "Edit notes.txt" });
	await expect(txtSource).toBeFocused();
	await txtSource.press("ControlOrMeta+a");
	await page.keyboard.insertText("First line\nUpdated line\n");
	await txtSource.press("ControlOrMeta+s");
	await expect.poll(() => readFile(txt, "utf8")).toBe("\uFEFFFirst line\r\nUpdated line\r\n");
	await preview.click();
	await expect(text).toContainText("Updated line");

	await open("data.tsv");
	await expect(text).toContainText("hello");
	await expect(edit).toBeEnabled();
});
