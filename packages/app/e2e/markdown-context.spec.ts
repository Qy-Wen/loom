import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ElectronApplication, Page } from "playwright";
import type { Locator } from "@playwright/test";
import { expect, test } from "./loom.ts";

type MenuItem = { label: string; enabled: boolean };
async function openFile(page: Page, app: ElectronApplication, root: string): Promise<void> {
	await app.evaluate(({ dialog }, path) => {
		const original = dialog.showOpenDialog;
		dialog.showOpenDialog = (async () => {
			dialog.showOpenDialog = original;
			return { canceled: false, filePaths: [path] };
		}) as typeof dialog.showOpenDialog;
	}, root);
	await page.evaluate(() => window.loom.openLibrary());
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath).toBe(root);
	await page.locator(".asset-row").filter({ hasText: "a.md" }).first().click();
	await expect(page.getByRole("textbox", { name: "Edit a.md" })).toBeVisible();
}

/** Exercise the real menu items and their IPC callbacks without leaving a native menu open in automation. */
async function menu(app: ElectronApplication, target: Locator, label?: string, x?: number): Promise<MenuItem[]> {
	await app.evaluate(({ Menu }, wanted) => {
		const state = globalThis as unknown as { contextMenuItems: { label: string; enabled: boolean }[] | null };
		state.contextMenuItems = null;
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			state.contextMenuItems = this.items.filter((item) => !!item.label).map((item) => ({ label: item.label, enabled: item.enabled }));
			this.items.find((item) => item.label === wanted && item.enabled)?.click();
			options?.callback?.();
		};
	}, label);
	await target.click({ button: "right", ...(x === undefined ? {} : { position: { x, y: 10 } }) });
	const items = () => app.evaluate(() => (globalThis as unknown as { contextMenuItems: MenuItem[] | null }).contextMenuItems);
	await expect.poll(items).not.toBeNull();
	return (await items())!;
}

const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());

test("the Markdown text menu copies, cuts, pastes, selects all and uses the editor undo history", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-context-"));
	const file = join(root, "a.md");
	const text = "alpha beta\n\ngamma delta\n";
	await writeFile(file, text);
	try {
		await openFile(page, electronApp!, root);
		const box = page.getByRole("textbox", { name: "Edit a.md" });
		const first = box.locator(".cm-line").first();
		await first.click({ clickCount: 2, position: { x: 20, y: 10 } });
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("alpha");
		await menu(electronApp!, first, "Copy", 20);
		await expect.poll(() => clipboardText(electronApp!)).toBe("alpha");
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("alpha");

		await page.getByRole("button", { name: "Source mode", exact: true }).click();
		await menu(electronApp!, first, "Select All", 20);
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
		await menu(electronApp!, first, "Cut", 20);
		await expect(box).toHaveText("");
		await expect.poll(() => clipboardText(electronApp!)).toBe(text);
		await menu(electronApp!, first, "Paste", 5);
		await expect(box).toContainText("gamma delta");
		await menu(electronApp!, first, "Undo", 20);
		await expect(box).toHaveText("");
		await menu(electronApp!, first, "Redo", 5);
		await expect(box).toContainText("gamma delta");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe(text);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("reading offers copy and select all but disables clipboard mutations and history", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-context-read-"));
	const file = join(root, "a.md");
	await writeFile(file, "alpha beta\n");
	try {
		await openFile(page, electronApp!, root);
		const box = page.getByRole("textbox", { name: "Edit a.md" });
		await box.focus();
		await box.press("ControlOrMeta+End");
		await box.pressSequentially("!");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe("alpha beta\n!");
		await page.getByRole("button", { name: "Reading mode", exact: true }).click();
		const first = box.locator(".cm-line").first();
		await electronApp!.evaluate(({ clipboard }) => clipboard.writeText("forbidden"));
		const items = await menu(electronApp!, first, "Select All", 20);
		for (const label of ["Undo", "Redo", "Cut", "Paste"]) expect(items.find((item) => item.label === label)?.enabled).toBe(false);
		await menu(electronApp!, first, "Copy", 20);
		await expect.poll(() => clipboardText(electronApp!)).toBe("alpha beta\n!");
		await menu(electronApp!, first, "Paste", 20);
		await expect(box).toHaveAttribute("aria-readonly", "true");
		expect(await readFile(file, "utf8")).toBe("alpha beta\n!");
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("table menus copy and paste cell blocks, keep partial cell text and remain read-only while reading", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated Electron required");
	const root = await mkdtemp(join(tmpdir(), "loom-md-context-table-"));
	const file = join(root, "a.md");
	const text = "| A | B |\n| - | - |\n| one | two |\n| three | four |\n\nend\n";
	await writeFile(file, text);
	try {
		await openFile(page, electronApp!, root);
		const box = page.getByRole("textbox", { name: "Edit a.md" });
		const table = box.locator(".cm-live-table");
		const one = table.locator('td[data-row="1"][data-column="0"]');
		const four = table.locator('td[data-row="2"][data-column="1"]');
		await expect(one).toHaveText("one");
		await menu(electronApp!, one, "Copy");
		await expect.poll(() => clipboardText(electronApp!)).toContain("| one |");

		await one.click();
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Shift+End");
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("ne");
		await menu(electronApp!, one, "Copy", 30);
		await expect.poll(() => clipboardText(electronApp!)).toBe("ne");
		await menu(electronApp!, one, "Cut", 30);
		await expect(one).toHaveText("o");
		await menu(electronApp!, one, "Paste", 10);
		await expect(one).toHaveText("one");
		await menu(electronApp!, one, "Select All", 10);
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("one");

		const a = (await one.boundingBox())!;
		const b = (await four.boundingBox())!;
		await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
		await page.mouse.up();
		await expect(table.locator(".cm-live-table-range")).toHaveCount(1);
		await menu(electronApp!, one, "Copy");
		await expect.poll(() => clipboardText(electronApp!)).toContain("| three | four |");
		await menu(electronApp!, one, "Cut");
		await expect(one).toHaveText("");
		await expect(four).toHaveText("");
		await menu(electronApp!, one, "Paste");
		await expect(one).toHaveText("one");
		await expect(four).toHaveText("four");
		await box.press("ControlOrMeta+s");
		await expect.poll(() => readFile(file, "utf8")).toBe(text);
		await electronApp!.evaluate(({ clipboard }) => clipboard.writeText("five\tsix\nseven\teight"));
		await menu(electronApp!, four, "Paste");
		await expect(table.locator("th")).toHaveCount(3);
		await expect(table.locator("tbody tr")).toHaveCount(3);
		await expect(table.locator('td[data-row="3"][data-column="2"]')).toHaveText("eight");
		await menu(electronApp!, one, "Undo");
		await expect(table.locator("th")).toHaveCount(2);
		await expect(four).toHaveText("four");

		await page.getByRole("button", { name: "Reading mode", exact: true }).click();
		const items = await menu(electronApp!, one, "Select All");
		for (const label of ["Cut", "Paste", "Undo", "Redo"]) expect(items.find((item) => item.label === label)?.enabled).toBe(false);
		expect(items.some((item) => item.label.startsWith("Insert row") || item.label.startsWith("Delete"))).toBe(false);
		await menu(electronApp!, one, "Copy");
		await expect.poll(() => clipboardText(electronApp!)).toBe(text.split("\n\n")[0].replace("| - | - |", "| --- | --- |"));
		expect(await readFile(file, "utf8")).toBe(text);
	} finally { await rm(root, { recursive: true, force: true }); }
});
