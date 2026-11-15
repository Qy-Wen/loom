import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./loom.ts";

type Effects = { copiedPath: string; revealed: string[]; trashed: string[] };
const effects = (app: ElectronApplication) => app.evaluate(() => (globalThis as typeof globalThis & { shortcutEffects: Effects }).shortcutEffects);

async function prepare(page: Page, mode: "List" | "Icons") {
	const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
	for (const folder of ["source", "target", "browse"]) await mkdir(join(root, folder));
	await writeFile(join(root, "source", "note.md"), "source note");
	await writeFile(join(root, "outside.md"), "outside note");
	await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).assets.length).toBe(2);
	const sidebar = page.locator(".library-sidebar");
	if (mode === "Icons") await sidebar.getByRole("group", { name: "File display", exact: true }).getByRole("button", { name: "Icons", exact: true }).click();
	const folder = (name: string) => sidebar.locator(".folder-row").filter({ hasText: new RegExp(`^${name}$`) }).first().locator(".folder-main");
	await folder("source").click();
	if (mode === "Icons") {
		// A tile selection must never become the target of shortcuts in the folder tree.
		await page.locator(".browser-tile").filter({ hasText: "note.md" }).click();
		await sidebar.focus();
	}
	return { root, sidebar, folder };
}

for (const mode of ["List", "Icons"] as const) {
	test(`tree action shortcuts use the focused folder in ${mode} mode`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(90_000);
		await electronApp!.evaluate(({ shell, clipboard }) => {
			const state = globalThis as typeof globalThis & { shortcutEffects: Effects };
			state.shortcutEffects = { copiedPath: "", revealed: [], trashed: [] };
			clipboard.writeText = (text) => { state.shortcutEffects.copiedPath = text; };
			shell.showItemInFolder = (path) => { state.shortcutEffects.revealed.push(path); };
			shell.trashItem = async (path) => { state.shortcutEffects.trashed.push(path); };
		});
		const { root, sidebar, folder } = await prepare(page, mode);
		const trashKey = process.platform === "darwin" ? "Meta+Backspace" : "Delete";
		const dialog = page.locator(".confirmation-dialog");
		await page.keyboard.press(trashKey);
		await expect(dialog.locator("h2")).toContainText("source");
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		expect((await effects(electronApp!)).trashed).toEqual([]);

		await page.keyboard.press("ControlOrMeta+Alt+c");
		await expect.poll(async () => (await effects(electronApp!)).copiedPath).toBe(join(root, "source"));
		await page.keyboard.press("ControlOrMeta+Alt+r");
		await expect.poll(async () => (await effects(electronApp!)).revealed).toEqual([join(root, "source")]);
		await folder("target").click({ button: "right" });
		await expect(sidebar.locator(".folder-row.selected .asset-name")).toHaveText("target");
		await page.keyboard.press(trashKey);
		await expect(dialog.locator("h2")).toContainText("target");
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await folder("source").click();
		// Duplicate is file-only in both modes; a stale tile must not be duplicated here.
		await page.keyboard.press("ControlOrMeta+d");
		await page.keyboard.press("F2");
		const rename = sidebar.locator(".rename-editor input");
		await expect(rename).toHaveValue("source");
		await rename.fill("renamed");
		await rename.press("Enter");
		await expect(rename).toHaveCount(0);
		await expect(sidebar.locator(".folder-row.selected .asset-name")).toHaveText("renamed");
		await sidebar.focus();
		await page.keyboard.press("ControlOrMeta+Shift+n");
		await expect(rename).toBeVisible();
		await rename.press("ControlOrMeta+a");
		await rename.press("Delete");
		await expect(rename).toHaveValue("");
		await expect(dialog).toHaveCount(0);
		await rename.fill("child");
		await rename.press("Enter");
		await expect(rename).toHaveCount(0);
		await expect(sidebar.locator(".folder-row.selected .asset-name")).toHaveText("child");
		await sidebar.focus();
		await page.keyboard.press("ControlOrMeta+a");
		await expect(sidebar.locator(".folder-row.selected .asset-name")).toHaveText(["browse", "renamed", "child", "target"]);
		await page.keyboard.press("F2");
		await expect(rename).toHaveCount(0);
		await page.keyboard.press("Home");
		await page.keyboard.press("Shift+End");
		await expect(sidebar.locator(".folder-row.selected .asset-name")).toHaveText(["browse", "renamed", "child", "target"]);
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(folder("child")).toHaveCount(0);
		await page.keyboard.press("Enter");
		await expect(folder("child")).toBeVisible();
		expect((await page.evaluate(() => window.loom.getLibrarySnapshot())).assets).toHaveLength(2);

		await folder("renamed").click();
		await page.keyboard.press(trashKey);
		await expect(dialog.locator("h2")).toContainText("renamed");
		await dialog.locator(".confirmation-primary").click();
		await expect.poll(async () => (await effects(electronApp!)).trashed).toEqual([join(root, "renamed")]);
		expect(await readFile(join(root, "outside.md"), "utf8")).toBe("outside note");
	});

	test(`tree copy, cut, paste and new-folder shortcuts use the focused destination in ${mode} mode`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		const { root, sidebar, folder } = await prepare(page, mode);
		const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
		await page.keyboard.press("ControlOrMeta+c");
		await folder("browse").click();
		await folder("target").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
		await page.keyboard.press("ControlOrMeta+v");
		await expect.poll(async () => (await snapshot()).assets.some(asset => asset.relativePath === "target/source/note.md")).toBe(true);
		expect(await readFile(join(root, "target", "source", "note.md"), "utf8")).toBe("source note");
		expect((await snapshot()).folders).not.toContain("browse/source");

		await folder("source").click();
		await page.keyboard.press("ControlOrMeta+x");
		await expect(folder("source").locator("..")).toHaveClass(/cut/);
		await folder("browse").click();
		await page.keyboard.press("ControlOrMeta+v");
		await expect.poll(async () => (await snapshot()).folders.includes("source")).toBe(false);
		expect((await snapshot()).folders).toContain("browse/source");
		expect(await readFile(join(root, "browse", "source", "note.md"), "utf8")).toBe("source note");

		await folder("browse").click();
		await folder("target").click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
		await page.keyboard.press("ControlOrMeta+Shift+n");
		await expect(sidebar.locator(".rename-editor input")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect.poll(async () => (await snapshot()).folders.includes("target/New Folder")).toBe(true);
		expect((await snapshot()).folders).not.toContain("browse/New Folder");
	});
}
