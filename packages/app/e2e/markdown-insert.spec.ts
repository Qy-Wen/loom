import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import { expect, test } from "./loom.ts";

async function libraryPath(page: Page): Promise<string> {
	const root = () => page.evaluate(async () => (await window.loom.getLibrarySnapshot()).rootPath);
	await expect.poll(root).toBeTruthy();
	return (await root())!;
}

function openNote(page: Page) {
	return page.locator(".library-sidebar .asset-row").filter({ hasText: "commands.md" }).click();
}

test("slash commands search in Chinese, respect IME Enter and create an editable table", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const file = join(await libraryPath(loomPage), "commands.md");
	await writeFile(file, "Before\n\nAfter\n");
	await openNote(loomPage);
	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+End");
	await box.press("ArrowUp");
	await box.press("ArrowUp");
	await loomPage.keyboard.insertText("/");
	const firstOption = menu.getByRole("option", { name: "Heading 1", exact: true });
	await expect(firstOption).toHaveAttribute("aria-selected", "true");
	await expect(firstOption).toHaveCSS("padding", "6px 8px");
	await expect(menu.getByRole("option").locator("svg.markdown-insert-icon[aria-hidden=true]")).toHaveCount(13);
	await box.press("ArrowUp");
	const lastOption = menu.getByRole("option", { name: "Link to a library file", exact: true });
	await expect(lastOption).toHaveAttribute("aria-selected", "true");
	await expect(lastOption).toBeInViewport({ ratio: 0.95 });
	await box.press("ArrowDown");
	await box.press("ArrowDown");
	await expect(menu.getByRole("option", { name: "Heading 2", exact: true })).toHaveAttribute("aria-selected", "true");
	await loomPage.keyboard.insertText("表格");
	await expect(menu.getByRole("option", { name: "Table", exact: true })).toHaveAttribute("aria-selected", "true");
	await box.dispatchEvent("keydown", { key: "Enter", isComposing: true });
	await expect(menu).toBeVisible();
	await box.press("Enter");

	const firstCell = box.locator(".cm-live-table th[contenteditable=plaintext-only]").first();
	await expect(firstCell).toBeFocused();
	await loomPage.keyboard.insertText("Name");
	await loomPage.keyboard.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Before\n\n| Name |  |\n| --- | --- |\n|  |  |\n\nAfter\n");
});

test("the Insert button and slash menu create undoable, portable Markdown", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	const reference = join(root, "参考 (v1).md");
	await writeFile(file, "Existing paragraph\n");
	await writeFile(reference, "# Reference\n");
	await openNote(loomPage);
	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const button = loomPage.getByRole("button", { name: "Insert", exact: true });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ArrowRight");
	await button.click();
	await expect(menu).toBeVisible();
	await box.press("Escape");
	await expect(menu).toBeHidden();
	await box.press("ControlOrMeta+s");
	expect(await readFile(file, "utf8")).toBe("Existing paragraph\n");

	await button.click();
	await menu.getByRole("option", { name: "Heading 2", exact: true }).click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Existing paragraph\n\n## \n");
	await box.press("ControlOrMeta+z");
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Existing paragraph\n");

	await electronApp!.evaluate(({ dialog }, path) => {
		const original = dialog.showOpenDialog;
		dialog.showOpenDialog = (async () => {
			dialog.showOpenDialog = original;
			return { canceled: false, filePaths: [path] };
		}) as typeof dialog.showOpenDialog;
	}, reference);
	await box.press("ControlOrMeta+End");
	await loomPage.keyboard.insertText("/link");
	await menu.getByRole("option", { name: "Link to a library file", exact: true }).click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("Existing paragraph\n\n[参考 (v1).md](%E5%8F%82%E8%80%83%20%28v1%29.md)");
	await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
	await expect(button).toHaveCount(0);
	const link = box.locator("[data-asset-id]").filter({ hasText: "参考 (v1).md" });
	await link.click();
	await expect(loomPage.getByRole("textbox", { name: "Edit 参考 (v1).md" })).toBeVisible();
});

test("wiki link completion filters files and replaces only the link target", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	const first = "Alpha/参考.md";
	const second = "Beta/参考.md";
	await mkdir(join(root, "Alpha"));
	await mkdir(join(root, "Beta"));
	await writeFile(join(root, first), "# First");
	await writeFile(join(root, second), "# Second");
	await writeFile(join(root, "unrelated.md"), "# Unrelated");
	await writeFile(file, "后缀\n\n[[旧#标题|别名]]\n\n```\n\n```");
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+Home");
	await loomPage.keyboard.insertText("[[");
	await expect(menu.getByRole("option", { name: "unrelated.md" })).toBeVisible();
	await loomPage.getByRole("button", { name: "Insert", exact: true }).click();
	await expect(menu.getByRole("option", { name: "Heading 1", exact: true })).toBeVisible();
	await box.press("Escape");
	await box.press("Home");
	await box.press("ArrowRight");
	await box.press("ArrowRight");
	await expect(menu.getByRole("option", { name: "unrelated.md" })).toBeVisible();
	await loomPage.keyboard.insertText("参考");
	await expect(menu.getByRole("option")).toHaveCount(2);
	const activeOption = menu.locator('[aria-selected="true"]');
	const initial = await activeOption.innerText();
	await box.press("ArrowDown");
	await expect(activeOption).not.toHaveText(initial);
	const chosen = await activeOption.innerText();
	expect([first, second]).toContain(chosen);
	await box.dispatchEvent("keydown", { key: "Enter", isComposing: true });
	await expect(menu).toBeVisible();
	await box.press("Enter");
	await loomPage.keyboard.insertText(" 后续");
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toContain(`[[${chosen}]] 后续后缀`);

	const existing = box.locator(".cm-line").filter({ hasText: "别名" });
	await existing.click();
	await box.press("Home");
	await box.press("ArrowRight");
	await box.press("ArrowRight");
	await expect(menu.getByRole("option", { name: first })).toBeVisible();
	await box.press("Escape");
	await expect(menu).toBeHidden();
	await box.press("ArrowLeft");
	await box.press("ArrowRight");
	await menu.getByRole("option", { name: first }).click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toContain(`[[${first}#标题|别名]]`);

	await box.press("ControlOrMeta+End");
	await box.press("ArrowUp");
	await loomPage.keyboard.insertText("[[");
	await expect(box.locator(".cm-live-codeblock").filter({ hasText: "[[" })).toBeVisible();
	await expect(menu).toBeHidden();
});

test("backspacing an existing wiki target reopens file completion", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await libraryPath(loomPage);
	const file = join(root, "commands.md");
	await writeFile(file, "[[zzz]]\n");
	await writeFile(join(root, "reference.md"), "# Reference\n");
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+Home");
	await box.press("End");
	await box.press("ArrowLeft");
	await box.press("ArrowLeft");
	for (const _ of "zzz") await box.press("Shift+ArrowLeft");
	await expect(menu).toBeHidden();
	await box.press("Backspace");
	const reference = menu.getByRole("option", { name: "reference.md", exact: true });
	await expect(reference).toBeVisible();
	await reference.click();
	await box.press("ControlOrMeta+s");
	await expect.poll(() => readFile(file, "utf8")).toBe("[[reference.md]]\n");
});

test("deleting a slash query reopens command completion", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	await writeFile(join(await libraryPath(loomPage), "commands.md"), "/tablezz\n\nParagraph\n");
	await openNote(loomPage);

	const box = loomPage.getByRole("textbox", { name: "Edit commands.md" });
	const menu = loomPage.locator(".cm-markdown-insert").getByRole("listbox");
	await box.press("ControlOrMeta+Home");
	await box.press("End");
	await expect(menu).toBeHidden();
	await box.press("Backspace");
	await box.press("Backspace");
	await expect(menu.getByRole("option", { name: "Table", exact: true })).toBeVisible();

	for (const _ of "table") await box.press("Shift+ArrowLeft");
	await expect(menu).toBeHidden();
	await box.press("Delete");
	await expect(menu.getByRole("option", { name: "Heading 1", exact: true })).toBeVisible();

	await box.press("ControlOrMeta+End");
	await box.press("ArrowUp");
	await box.press("End");
	await box.press("Backspace");
	await expect(box.locator(".cm-line").filter({ hasText: /^Paragrap$/ })).toBeVisible();
	await expect(menu).toBeHidden();
});
