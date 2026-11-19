import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { expect, test } from "./loom.ts";

async function openLibrary(page: Page, app: ElectronApplication, root: string): Promise<void> {
	await app.evaluate(({ dialog }, path) => {
		const original = dialog.showOpenDialog;
		dialog.showOpenDialog = (async () => {
			dialog.showOpenDialog = original;
			return { canceled: false, filePaths: [path] };
		}) as typeof dialog.showOpenDialog;
	}, root);
	await page.evaluate(() => window.loom.openLibrary());
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(root);
}

const selectFile = (page: Page, name: string) => page.locator(".library-sidebar, aside").first().locator(".asset-row").filter({ hasText: name }).first().click();

test("Markdown opens in edit mode and switches modes in one view without losing history or position", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-modes-"));
	const file = join(root, "a.md");
	await writeFile(file, "# Title\n\nalpha **bold**\n\n" + "paragraph\n\n".repeat(100));
	try {
		await openLibrary(loomPage, electronApp!, root);
		await selectFile(loomPage, "a.md");
		const box = loomPage.getByRole("textbox", { name: "Edit a.md" });
		await expect(box).toBeVisible();
		await expect(loomPage.getByRole("tab", { name: "Source", exact: true })).toHaveCount(0);
		const source = loomPage.getByRole("button", { name: "Source mode", exact: true });
		await expect(source).toHaveAttribute("aria-pressed", "false");
		await expect(loomPage.locator(".markdown-editor-input")).toHaveCSS("background-color", "rgb(255, 255, 255)");
		await expect(loomPage.locator(".cm-editor")).toHaveCSS("background-color", "rgb(255, 255, 255)");
		await expect(source).toHaveAttribute("data-tooltip", "Source mode");
		await box.click();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("new text");
		const original = await box.elementHandle();
		const scroll = () => loomPage.locator(".cm-scroller").evaluate((el) => el.scrollTop);
		const before = await scroll();
		await source.click();
		await expect(source).toHaveAttribute("aria-pressed", "true");
		await expect(loomPage.locator(".cm-editor")).toHaveCSS("background-color", "rgb(255, 255, 255)");
		await expect(loomPage.locator(".cm-live-hidden")).toHaveCount(0);
		await expect.poll(() => original!.evaluate((el) => el === document.querySelector(".cm-content"))).toBe(true);
		await box.pressSequentially("!");
		await source.click();
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await expect(source).toHaveCount(0);
		const toolbar = loomPage.getByRole("toolbar", { name: "Markdown view" });
		await expect(toolbar).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(toolbar).toHaveCSS("border-bottom-width", "0px");
		await expect(loomPage.locator(".cm-editor")).toHaveCSS("background-color", "rgb(255, 255, 255)");
		await expect(box).toHaveAttribute("aria-readonly", "true");
		await expect.poll(() => original!.evaluate((el) => el === document.querySelector(".cm-content"))).toBe(true);
		expect(Math.abs((await scroll()) - before)).toBeLessThan(100);
		await expect.poll(() => readFile(file, "utf8")).toContain("new text!");
		await loomPage.getByRole("button", { name: "Edit mode", exact: true }).click();
		await expect(source).toHaveAttribute("aria-pressed", "false");
		await box.focus();
		await box.press("ControlOrMeta+z");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).not.toContain("new text!");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reading hides the caret after text clicks but keeps selection, copy and search usable", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-reading-caret-"));
	const text = "alpha beta\n\ngamma delta\n";
	await writeFile(join(root, "a.md"), text);
	try {
		await openLibrary(loomPage, electronApp!, root);
		await selectFile(loomPage, "a.md");
		const box = loomPage.getByRole("textbox", { name: "Edit a.md" });
		const line = box.locator(".cm-line").filter({ hasText: "alpha beta" });
		const cursor = loomPage.locator(".cm-cursor-primary");
		await line.click();
		await expect(cursor).toBeVisible();
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await line.click();
		await expect(box).toBeFocused();
		await expect(cursor).toHaveCount(1);
		await expect(cursor).toBeHidden();
		await expect(box).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");

		const bounds = (await line.boundingBox())!;
		await loomPage.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 5 });
		await loomPage.mouse.up();
		await expect.poll(() => loomPage.evaluate(() => window.getSelection()?.toString())).toBe("alpha beta");
		await loomPage.keyboard.press("ControlOrMeta+c");
		expect(await electronApp!.evaluate(({ clipboard }) => clipboard.readText())).toBe("alpha beta");
		await loomPage.keyboard.press("ControlOrMeta+f");
		const find = loomPage.locator('.cm-search input[name="search"]');
		await expect(find).toBeFocused();
		expect(await find.evaluate((el) => getComputedStyle(el).caretColor)).not.toBe("rgba(0, 0, 0, 0)");
		await find.pressSequentially("gamma");
		await find.press("Enter");
		await expect(box.locator(".cm-searchMatch")).toHaveText("gamma");
		await loomPage.keyboard.press("Escape");
		await line.click();
		await expect(cursor).toBeHidden();

		await loomPage.getByRole("button", { name: "Edit mode", exact: true }).click();
		await line.click();
		await expect(cursor).toBeVisible();
		await loomPage.getByRole("button", { name: "Source mode", exact: true }).click();
		await line.click();
		await expect(cursor).toBeVisible();
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await line.click();
		await expect(cursor).toBeHidden();
		expect(await readFile(join(root, "a.md"), "utf8")).toBe(text);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reading mode keeps results drawn, forbids table and task edits, copies cells and shares find", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-reading-"));
	const file = join(root, "a.md");
	const text = "# Title\n\n**bold** and $x^2$\n\n- [ ] task\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n| - | - |\n| one | two |\n\nend\n";
	await writeFile(file, text);
	try {
		await openLibrary(loomPage, electronApp!, root);
		await selectFile(loomPage, "a.md");
		const box = loomPage.getByRole("textbox", { name: "Edit a.md" });
		await expect(box).toBeVisible();
		await box.locator(".cm-live-strong").click();
		const boldLine = box.locator(".cm-line").filter({ hasText: "bold" });
		await expect(boldLine).toContainText("**bold**");
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await expect(boldLine.locator(".cm-live-hidden")).toHaveCount(2);
		const before = await stat(file);
		await box.locator(".cm-live-strong").click();
		await expect(box.locator(".cm-live-strong")).toHaveText("bold");
		await box.pressSequentially("forbidden");
		await box.press("Backspace");
		await box.press("ControlOrMeta+z");
		await expect(box.locator(".cm-live-checkbox")).toBeDisabled();
		await box.locator(".cm-live-checkbox").click({ force: true });
		await expect(box.locator(".cm-live-checkbox")).toHaveAttribute("aria-checked", "false");
		await box.locator(".katex-html").click();
		await expect(box.locator(".katex")).toHaveCount(1);
		const table = box.locator(".cm-live-table");
		await expect(table.locator("[contenteditable=plaintext-only]")).toHaveCount(0);
		await expect(table.locator(".cm-live-table-add-row, .cm-live-table-add-column, .cm-live-table-handle")).toHaveCount(0);
		const one = table.locator('td[data-row="1"][data-column="0"]');
		const two = table.locator('td[data-row="1"][data-column="1"]');
		await one.click();
		await expect(one).toHaveText("one");
		await electronApp!.evaluate(({ clipboard }) => clipboard.writeText("forbidden\tdata"));
		await loomPage.keyboard.press("ControlOrMeta+v");
		const a = (await one.boundingBox())!;
		const b = (await two.boundingBox())!;
		await loomPage.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
		await loomPage.mouse.down();
		await loomPage.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
		await loomPage.mouse.up();
		await expect(table.locator(".cm-live-table-range")).toHaveCount(1);
		await loomPage.keyboard.press("ControlOrMeta+c");
		expect(await electronApp!.evaluate(({ clipboard }) => clipboard.readText())).toContain("one | two");
		await loomPage.keyboard.press("ControlOrMeta+x");
		await loomPage.keyboard.press("Delete");
		await loomPage.keyboard.press("ControlOrMeta+v");
		await expect(one).toHaveText("one");
		await expect(two).toHaveText("two");
		await loomPage.keyboard.press("ControlOrMeta+f");
		const find = loomPage.locator(".cm-search");
		await expect(find).toBeVisible();
		await expect(find.locator('input[name="replace"]')).toHaveCount(0);
		await find.locator('input[name="search"]').fill("bold");
		await find.locator('input[name="search"]').press("Enter");
		await expect(box.locator(".cm-searchMatch")).toHaveCount(1);
		await expect(box.locator(".cm-live-strong")).toHaveText("bold");
		await loomPage.getByRole("button", { name: "Edit mode", exact: true }).click();
		await expect(find.locator('input[name="search"]')).toHaveValue("bold");
		await expect(find.locator('input[name="replace"]')).toHaveCount(1);
		await loomPage.keyboard.press("Escape");
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await loomPage.waitForTimeout(1200);
		expect(await readFile(file, "utf8")).toBe(text);
		expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("large Markdown uses source editing from 2 to 10 MiB and opens read-only beyond 10 MiB", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-large-"));
	const medium = "# medium\n\n" + "plain paragraph\n\n".repeat(Math.ceil(3 * 1048576 / 17));
	const large = "# large\n\n" + "plain paragraph\n\n".repeat(Math.ceil(11 * 1048576 / 17)) + "needle-at-end\n";
	await writeFile(join(root, "medium.md"), medium);
	await writeFile(join(root, "large.md"), large);
	try {
		await openLibrary(loomPage, electronApp!, root);
		await selectFile(loomPage, "medium.md");
		const box = loomPage.getByRole("textbox", { name: "Edit medium.md" });
		await expect(box).toBeVisible();
		await expect(loomPage.locator(".markdown-mode-notice")).toContainText("source mode");
		const source = loomPage.getByRole("button", { name: "Source mode", exact: true });
		await expect(source).toBeDisabled();
		await expect(source).toHaveAttribute("aria-pressed", "true");
		await expect(loomPage.locator(".cm-live-hidden")).toHaveCount(0);
		await box.focus();
		await box.press("ControlOrMeta+Home");
		await box.pressSequentially("X");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(join(root, "medium.md"), "utf8")).toBe("X" + medium);
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await expect(box).toHaveAttribute("aria-readonly", "true");
		await expect(source).toHaveCount(0);
		await selectFile(loomPage, "large.md");
		const reader = loomPage.getByRole("textbox", { name: "Edit large.md" });
		await expect(reader).toBeVisible();
		await expect(reader).toHaveAttribute("aria-readonly", "true");
		await expect(loomPage.locator(".markdown-mode-notice")).toContainText("read-only");
		await expect(loomPage.getByRole("button", { name: "Edit mode", exact: true })).toBeDisabled();
		const before = await stat(join(root, "large.md"));
		await reader.focus();
		await reader.press("ControlOrMeta+Home");
		await reader.pressSequentially("forbidden");
		await reader.press("ControlOrMeta+s");
		await reader.press("ControlOrMeta+f");
		const search = loomPage.locator('.cm-search input[name="search"]');
		await expect(search).toBeVisible();
		await search.pressSequentially("needle-at-end");
		await search.press("Enter");
		await expect(reader.locator(".cm-searchMatch")).toHaveText("needle-at-end");
		await expect(reader.locator(".cm-searchMatch")).toBeInViewport();
		await loomPage.keyboard.press("Escape");
		expect(await readFile(join(root, "large.md"), "utf8")).toBe(large);
		expect((await stat(join(root, "large.md"))).mtimeMs).toBe(before.mtimeMs);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("source mode removes all live widgets and carries a cell caret into the raw table", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-raw-"));
	const file = join(root, "a.md");
	const text = "$x^2$\n\n| A | B |\n| - | - |\n| one | two |\n\n```mermaid\ngraph TD; A-->B\n```\n\nend";
	await writeFile(file, text);
	try {
		await openLibrary(loomPage, electronApp!, root);
		await selectFile(loomPage, "a.md");
		const box = loomPage.getByRole("textbox", { name: "Edit a.md" });
		const source = loomPage.getByRole("button", { name: "Source mode", exact: true });
		await expect(box.locator(".cm-live-table")).toHaveCount(1);
		await box.locator("td").first().click();
		await loomPage.keyboard.press("End");
		await source.click();
		await expect(box).toBeFocused();
		await expect(box.locator(".cm-live-table, .cm-live-math, .cm-live-mermaid, .cm-live-hidden")).toHaveCount(0);
		await loomPage.keyboard.type("!");
		await loomPage.keyboard.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe(text.replace("| one |", "| one! |"));
		await source.click();
		await expect(box.locator("td").first()).toHaveText("one!");
		await loomPage.getByRole("button", { name: "Reading mode", exact: true }).click();
		await box.focus();
		await box.press("ControlOrMeta+z");
		await box.press("ControlOrMeta+s");
		expect(await readFile(file, "utf8")).toContain("| one! |");
		await loomPage.getByRole("button", { name: "Edit mode", exact: true }).click();
		await box.focus();
		await box.press("ControlOrMeta+z");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe(text);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("outside changes update the size tier only when adopted and never lock unsaved edits", async ({ loomPage, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), "loom-md-external-size-"));
	const file = join(root, "a.md");
	const large = "large paragraph\n\n".repeat(Math.ceil(11 * 1048576 / 17));
	await writeFile(file, "small\n");
	try {
		await openLibrary(loomPage, electronApp!, root);
		await selectFile(loomPage, "a.md");
		const box = loomPage.getByRole("textbox", { name: "Edit a.md" });
		await expect(box).toBeVisible();
		await writeFile(file, large);
		await expect(box).toHaveAttribute("aria-readonly", "true", { timeout: 15000 });
		await writeFile(file, "small again\n");
		await expect(box).toHaveAttribute("aria-readonly", "false", { timeout: 15000 });
		await expect(box).toContainText("small again");
		await box.focus();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("mine");
		await writeFile(file, large);
		await box.press("ControlOrMeta+s");
		const reload = loomPage.getByRole("button", { name: "Reload", exact: true });
		await expect(reload).toBeVisible({ timeout: 15000 });
		await expect(box).toHaveAttribute("aria-readonly", "false");
		await expect(box).toContainText("mine");
		await reload.click();
		await expect(box).toHaveAttribute("aria-readonly", "true");
		await expect(loomPage.locator(".markdown-mode-notice")).toContainText("read-only");
		expect(await readFile(file, "utf8")).toBe(large);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
