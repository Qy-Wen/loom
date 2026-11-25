import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readMacFilePaths } from "../src/main/desktop/mac-file-clipboard.ts";
import { readWindowsFilePaths } from "../src/main/desktop/windows-file-clipboard.ts";
import { expect, test } from "./loom.ts";

test("blank-area menus create and name Markdown files in the sidebar root and browsed folder", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await writeFile(join(root, "Untitled.md"), "keep the existing note");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("Untitled.md");
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			this.items.find((item) => item.label === "New File" && item.enabled)?.click();
			options?.callback?.();
		};
	});

	const sidebar = page.locator(".library-sidebar");
	const blank = sidebar.locator(".asset-list");
	const bounds = (await blank.boundingBox())!;
	await blank.click({ button: "right", position: { x: bounds.width / 2, y: bounds.height - 10 } });
	const listEditor = sidebar.locator(".rename-editor input");
	await expect(listEditor).toBeFocused();
	await expect(listEditor).toHaveValue("Untitled 2.md");
	await listEditor.fill("root note.md");
	await listEditor.press("Enter");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("root note.md");
	expect(await readFile(join(root, "Untitled.md"), "utf8")).toBe("keep the existing note");
	expect(await readFile(join(root, "root note.md"), "utf8")).toBe("");

	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click();
	const browser = page.locator(".folder-browser");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("notes");
	await browser.locator(".browser-empty").click({ button: "right" });
	const tileEditor = browser.locator(".browser-tile-rename input");
	await expect(tileEditor).toBeFocused();
	await expect(tileEditor).toHaveValue("Untitled.md");
	await tileEditor.fill("folder note.md");
	await tileEditor.press("Enter");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("notes/folder note.md");
	await expect(browser.locator(".browser-crumb.current")).toHaveText("notes");
	expect(await readFile(join(root, "notes", "folder note.md"), "utf8")).toBe("");
});

for (const display of ["Icons", "List"] as const) {
	test(`${display.toLowerCase()} mode creates folders at the library root from the sidebar blank area`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await mkdir(join(root, "parent", "child"), { recursive: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
		await electronApp!.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === "New Folder" && item.enabled)?.click();
				options?.callback?.();
			};
		});

		const sidebar = page.locator(".library-sidebar");
		const browser = page.locator(".folder-browser");
		await sidebar.getByRole("button", { name: display, exact: true }).click();
		await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
		if (display === "Icons") await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		const crumbs = await browser.locator(".browser-crumb").allTextContents();

		const blank = sidebar.locator(".asset-list");
		const bounds = await blank.boundingBox();
		await blank.click({ button: "right", position: { x: bounds!.width / 2, y: bounds!.height - 10 } });
		const editor = sidebar.locator(".rename-editor input");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("New Folder");
		await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
		await editor.fill("created-at-root");
		await editor.press("Enter");
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["created-at-root", "parent", "parent/child"]);
		await expect(sidebar.locator(".folder-row.selected")).toHaveText("created-at-root");
		if (display === "Icons") {
			await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);

			// The browser's blank area still creates inside the folder being browsed.
			await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
			await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
			await browser.locator(".browser-empty").click({ button: "right" });
			const browserEditor = browser.locator(".browser-tile-rename input");
			await expect(browserEditor).toBeFocused();
			await expect(editor).toHaveCount(0);
			await browserEditor.fill("created-in-child");
			await browserEditor.press("Enter");
			await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toEqual(["created-at-root", "parent", "parent/child", "parent/child/created-in-child"]);
			await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		}
	});
}

for (const source of ["folder menu", "shortcut"] as const) {
	test(`icon-mode tree ${source} creates and names folders in the tree`, async ({ loomPage: page, electronApp }) => {
		test.skip(!electronApp, "isolated library required");
		test.setTimeout(60_000);
		await expect.poll(async () => (await page.evaluate(() => window.loom.listSessions())).length).toBe(1);
		const root = (await page.evaluate(() => window.loom.getLibrarySnapshot())).rootPath!;
		await mkdir(join(root, "parent", "child"), { recursive: true });
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders.length).toBe(2);
		await electronApp!.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				this.items.find((item) => item.label === "New Folder" && item.enabled)?.click();
				options?.callback?.();
			};
		});
		const sidebar = page.locator(".library-sidebar");
		const browser = page.locator(".folder-browser");
		await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
		await sidebar.locator(".folder-main").filter({ hasText: /^child$/ }).click();
		await expect(browser.locator(".browser-crumb.current")).toHaveText("child");
		const crumbs = await browser.locator(".browser-crumb").allTextContents();
		if (source === "folder menu") {
			// A collapsed ancestor must open to show the new folder without navigating away.
			await sidebar.locator(".folder-row").filter({ hasText: /^parent$/ }).getByRole("button", { name: "Collapse folder" }).click();
			await sidebar.locator(".folder-main").filter({ hasText: /^parent$/ }).click({ button: "right" });
		} else {
			await sidebar.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+N`);
		}
		const editor = sidebar.locator(".rename-editor input");
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue("New Folder");
		await expect(browser.locator(".browser-tile-rename")).toHaveCount(0);
		await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
		await editor.fill("created-in-tree");
		await editor.press("Enter");
		const expected = source === "folder menu" ? "parent/created-in-tree" : "parent/child/created-in-tree";
		await expect.poll(async () => (await page.evaluate(() => window.loom.getLibrarySnapshot())).folders).toContain(expected);
		await expect(editor).toHaveCount(0);
		await expect(sidebar.locator(".folder-row.selected")).toHaveText("created-in-tree");
		await expect(browser.locator(".browser-crumb")).toHaveText(crumbs);
	});
}

test("folder menu leads with New Folder, New File and New Canvas, and creates Markdown inside the folder", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await expect.poll(async () => (await snapshot()).folders).toContain("notes");
	await electronApp!.evaluate(({ Menu }) => {
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			const labels = this.items.filter((item) => item.type !== "separator").map((item) => item.label);
			(globalThis as { menuLabels?: string[] }).menuLabels = labels;
			this.items.find((item) => item.label === "New File" && item.enabled)?.click();
			options?.callback?.();
		};
	});

	const sidebar = page.locator(".library-sidebar");
	await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click({ button: "right" });
	await expect.poll(async () => (await electronApp!.evaluate(() => (globalThis as { menuLabels?: string[] }).menuLabels))?.slice(0, 3))
		.toEqual(["New Folder", "New File", "New Canvas"]);
	const editor = sidebar.locator(".rename-editor input");
	await expect(editor).toBeFocused();
	await editor.fill("inside.md");
	await editor.press("Enter");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("notes/inside.md");
});

test("the library root menu acts on the root while another folder is open", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await writeFile(join(root, "notes", "source.md"), "# Paste into the root");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toEqual(["notes/source.md"]);
	const sidebar = page.locator(".library-sidebar");
	const rootButton = sidebar.locator(".library-root-button");
	const browser = page.locator(".folder-browser");
	await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
	await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click();
	await expect(browser.locator(".browser-crumb.current")).toHaveText("notes");
	const reveal = process.platform === "darwin" ? "Show in Finder" : process.platform === "win32" ? "Show in File Explorer" : "Show in file manager";
	type MenuState = { action: string; labels: string[]; revealed: string | undefined };
	await electronApp!.evaluate(({ clipboard, Menu, shell }) => {
		const state: MenuState = { action: "", labels: [], revealed: undefined };
		(globalThis as typeof globalThis & { rootMenu: MenuState }).rootMenu = state;
		clipboard.writeText("Text without file references");
		shell.showItemInFolder = (path) => { state.revealed = path; };
		Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
			state.labels = this.items.filter((item) => item.type !== "separator").map(({ label, enabled }) => enabled ? label : `${label} (disabled)`);
			this.items.find((item) => item.label === state.action && item.enabled)?.click();
			options?.callback?.();
		};
	});
	const readMenu = () => electronApp!.evaluate(() => (globalThis as typeof globalThis & { rootMenu: MenuState }).rootMenu);
	const openMenu = async (action: string, keyboard = false) => {
		await electronApp!.evaluate((_electron, action) => {
			Object.assign((globalThis as typeof globalThis & { rootMenu: MenuState }).rootMenu, { action, labels: [] });
		}, action);
		if (keyboard) await rootButton.press("Shift+F10");
		else await rootButton.click({ button: "right" });
		await expect.poll(async () => (await readMenu()).labels.length).toBeGreaterThan(0);
	};

	await openMenu("Copy Path", true);
	expect((await readMenu()).labels).toEqual(["New Folder", "New File", "New Canvas", "Copy", "Paste (disabled)", "Copy Path", reveal]);
	await expect(rootButton).toBeFocused();
	await expect.poll(() => electronApp!.evaluate(({ clipboard }) => clipboard.readText())).toBe(root);
	await openMenu(reveal);
	await expect.poll(async () => (await readMenu()).revealed).toBe(root);
	await expect(browser.locator(".browser-crumb.current")).toHaveText("notes");
	if (process.platform === "darwin" || process.platform === "win32") {
		await openMenu("Copy");
		const readPaths = process.platform === "darwin" ? readMacFilePaths : readWindowsFilePaths;
		await expect.poll(() => readPaths()).toEqual([root]);
	}
	const source = (await snapshot()).assets.find((asset) => asset.relativePath === "notes/source.md")!;
	await page.evaluate((id) => window.loom.copyLibraryItems([id], [], false), source.assetId);
	await openMenu("Paste");
	await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain("source.md");
	expect(await readFile(join(root, "source.md"), "utf8")).toBe("# Paste into the root");

	await openMenu("New Folder");
	const folderEditor = sidebar.locator(".rename-editor input");
	await expect(folderEditor).toBeFocused();
	await folderEditor.fill("created at root");
	await folderEditor.press("Enter");
	await expect.poll(async () => (await snapshot()).folders).toContain("created at root");
	for (const [action, name] of [["New File", "root note.md"], ["New Canvas", "root board.canvas"]]) {
		await openMenu(action);
		const editor = browser.locator(".browser-tile-rename input");
		await expect(editor).toBeFocused();
		await editor.fill(name);
		await editor.press("Enter");
		await expect.poll(async () => (await snapshot()).assets.map((asset) => asset.relativePath)).toContain(name);
	}
});

test("file menus create Markdown and canvas files next to the clicked file", async ({ loomPage: page, electronApp }) => {
	test.skip(!electronApp, "isolated library required");
	const snapshot = () => page.evaluate(() => window.loom.getLibrarySnapshot());
	await expect.poll(async () => (await snapshot()).rootPath).toBeTruthy();
	const root = (await snapshot()).rootPath!;
	await mkdir(join(root, "notes"));
	await writeFile(join(root, "notes", "existing.md"), "# Existing");
	const paths = async () => (await snapshot()).assets.map((asset) => asset.relativePath);
	await expect.poll(paths).toContain("notes/existing.md");
	const sidebar = page.locator(".library-sidebar");
	const browser = page.locator(".folder-browser");
	const folder = sidebar.locator(".folder-row").filter({ hasText: /^notes$/ });
	await expect(folder).toBeVisible();
	const expand = folder.getByRole("button", { name: "Expand folder" });
	if (await expand.count()) await expand.click();

	const cases = [
		{ label: "New File", file: sidebar.locator(".asset-row").filter({ hasText: "existing.md" }), editor: sidebar.locator(".rename-editor input"), stem: "sibling note", extension: "md" },
		{ label: "New Canvas", file: browser.locator(".browser-tile").filter({ hasText: "existing.md" }), editor: browser.locator(".browser-tile-rename input"), stem: "sibling canvas", extension: "canvas" },
	];
	for (const { label, file, editor, stem, extension } of cases) {
		if (extension === "canvas") {
			await sidebar.getByRole("button", { name: "Icons", exact: true }).click();
			await sidebar.locator(".folder-main").filter({ hasText: /^notes$/ }).click();
		}
		await electronApp!.evaluate(({ Menu }, label) => {
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				(globalThis as { fileMenuLabels?: string[] }).fileMenuLabels = this.items.map((item) => item.label);
				this.items.find((item) => item.label === label && item.enabled)?.click();
				options?.callback?.();
			};
		}, label);
		await file.click({ button: "right" });
		await expect(editor).toBeFocused();
		await editor.fill(`${stem}.${extension}`);
		await editor.press("Enter");
		await expect.poll(paths).toContain(`notes/${stem}.${extension}`);
		const labels = await electronApp!.evaluate(() => (globalThis as { fileMenuLabels?: string[] }).fileMenuLabels ?? []);
		const createStart = labels.indexOf("New Folder");
		expect(labels.slice(createStart, createStart + 3)).toEqual(["New Folder", "New File", "New Canvas"]);
		expect(labels).toContain("Copy");
		expect(labels).not.toContain("Duplicate");
	}
});
